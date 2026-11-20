// the signatures of the records of a zip file that the reader reads
const endSignature = 0x06054b50;
const entrySignature = 0x02014b50;
const localSignature = 0x04034b50;
const zip64LocatorSignature = 0x07064b50;

// the sizes of the records without their names, extra fields and comments: the end record, the zip64 locator before it,
// an entry of the central directory and the local header of an entry
const endSize = 22;
const zip64LocatorSize = 20;
const entrySize = 46;
const localSize = 30;
const maxCommentSize = 0xffff;

// field -> its offset in the end record
const endFields = { count: 10, directorySize: 12, directoryOffset: 16 };
// field -> its offset in an entry of the central directory
const entryFields = {
    flags: 8,
    method: 10,
    compressedSize: 20,
    size: 24,
    nameLength: 28,
    extraLength: 30,
    commentLength: 32,
    localOffset: 42,
};
// field -> its offset in the local header of an entry
const localFields = { nameLength: 26, extraLength: 28 };

const storedMethod = 0;
const deflatedMethod = 8;
const encryptedFlag = 1 << 0;

/** The most bytes that an entry inflates to, because a hostile entry of a few KB can inflate to gigabytes. */
export const maxEntryBytes = 16 * 1024 * 1024;

/**
 * The most bytes that the entries of a file inflate to in all, because the classes of a large JAR inflate to a few
 * hundred MB while many entries can share the data of 1 entry.
 */
export const maxFileBytes = 1024 * 1024 * 1024;

/** The failure to read a zip file or one of its entries, like a file that isn't a zip file. */
export class ZipError extends Error {}

interface Entry {
    flags: number;
    method: number;
    compressedSize: number;
    size: number;
    localOffset: number;
}

/** The entries of an open zip file. */
export interface Zip {
    names: string[];
    /** Reads an entry's bytes, or returns `null` for a name that the zip file doesn't have. */
    read(name: string): Promise<Uint8Array | null>;
}

function damaged(): ZipError {
    return new ZipError('The zip file is damaged.');
}

// inflates an entry's raw deflate data and throws for data that inflates to more or less than the size
async function inflate(data: Uint8Array, size: number): Promise<Uint8Array> {
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const bytes = new Uint8Array(size);
    let length = 0;

    // leaves the writer's errors to the reader because the reader fails with the same error
    writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
    writer.close().catch(() => {});
    try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            if (length + chunk.value.length > size) {
                await reader.cancel();
                throw damaged();
            }

            bytes.set(chunk.value, length);
            length += chunk.value.length;
        }
    } catch (error) {
        throw error instanceof ZipError ? error : damaged();
    }

    if (length !== size) {
        throw damaged();
    }

    return bytes;
}

// returns the end record's offset in the bytes of a file's end, or -1 for bytes without one
function findEnd(view: DataView): number {
    const first = Math.max(0, view.byteLength - endSize - maxCommentSize);
    let end = view.byteLength - endSize;
    while (end >= first && view.getUint32(end, true) !== endSignature) {
        end--;
    }

    return end < first ? -1 : end;
}

// reads the entries of a central directory that starts at `at` in the bytes, keeping the first entry of each name
function readEntries(bytes: Uint8Array, at: number, count: number): Map<string, Entry> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = new Map<string, Entry>();
    const decoder = new TextDecoder();

    for (let index = 0; index < count; index++) {
        if (at < 0 || at + entrySize > bytes.length || view.getUint32(at, true) !== entrySignature) {
            throw damaged();
        }

        const nameLength = view.getUint16(at + entryFields.nameLength, true);
        const extraLength = view.getUint16(at + entryFields.extraLength, true);
        const length = entrySize + nameLength + extraLength + view.getUint16(at + entryFields.commentLength, true);
        if (at + length > bytes.length) {
            throw damaged();
        }

        const name = decoder.decode(bytes.subarray(at + entrySize, at + entrySize + nameLength));
        if (!entries.has(name)) {
            entries.set(name, {
                flags: view.getUint16(at + entryFields.flags, true),
                method: view.getUint16(at + entryFields.method, true),
                compressedSize: view.getUint32(at + entryFields.compressedSize, true),
                size: view.getUint32(at + entryFields.size, true),
                localOffset: view.getUint32(at + entryFields.localOffset, true),
            });
        }

        at += length;
    }

    return entries;
}

// returns the count of bytes before the zip data, like a launch script, which the offsets of a zip file written before
// the bytes were added don't count, from the end record's offset and the central directory's offset and size in it
function findShift(end: number, directoryOffset: number, directorySize: number): number {
    return Math.max(0, end - directoryOffset - directorySize);
}

function isZip64(view: DataView, end: number, count: number, directoryOffset: number): boolean {
    const locator = end - zip64LocatorSize;
    const hasLocator = locator >= 0 && view.getUint32(locator, true) === zip64LocatorSignature;

    return hasLocator || count === 0xffff || directoryOffset === 0xffffffff;
}

/**
 * Reads the entries of a zip file in memory, like a JAR, from its central directory, also after other data like a
 * launch script. Inflates an entry on each read.
 */
export function openZip(bytes: Uint8Array): Zip {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = findEnd(view);
    if (end < 0) {
        throw new ZipError("The file isn't a zip file.");
    }

    const count = view.getUint16(end + endFields.count, true);
    const directoryOffset = view.getUint32(end + endFields.directoryOffset, true);
    if (isZip64(view, end, count, directoryOffset)) {
        throw new ZipError("The file is a zip64 file, which the engine can't read.");
    }

    const shift = findShift(end, directoryOffset, view.getUint32(end + endFields.directorySize, true));
    const entries = readEntries(bytes, directoryOffset + shift, count);
    // the names of the entries whose sizes count toward the file's limit
    const counted = new Set<string>();
    let fileBytes = 0;

    function fits(offset: number, length: number): boolean {
        return offset >= 0 && offset + length <= bytes.length;
    }

    // counts each entry's size once because a second read of an entry then stays within the file's limit
    function countEntry(name: string, { size }: Entry) {
        if (counted.has(name)) {
            return;
        }
        if (fileBytes + size > maxFileBytes) {
            throw new ZipError(`The entries of the zip file have more than ${maxFileBytes / 1024 / 1024} MB.`);
        }

        counted.add(name);
        fileBytes += size;
    }

    async function read(name: string): Promise<Uint8Array | null> {
        const entry = entries.get(name);
        if (!entry) {
            return null;
        }
        if (entry.flags & encryptedFlag) {
            throw new ZipError(`${name} is encrypted.`);
        }
        if (entry.size > maxEntryBytes) {
            throw new ZipError(`${name} has more than ${maxEntryBytes / 1024 / 1024} MB.`);
        }

        countEntry(name, entry);

        const localOffset = entry.localOffset + shift;
        if (!fits(localOffset, localSize) || view.getUint32(localOffset, true) !== localSignature) {
            throw damaged();
        }

        const nameLength = view.getUint16(localOffset + localFields.nameLength, true);
        const start = localOffset + localSize + nameLength + view.getUint16(localOffset + localFields.extraLength, true);
        if (!fits(start, entry.compressedSize)) {
            throw damaged();
        }

        const data = bytes.subarray(start, start + entry.compressedSize);
        if (entry.method === storedMethod) {
            if (data.length !== entry.size) {
                throw damaged();
            }

            return data.slice();
        }
        if (entry.method !== deflatedMethod) {
            throw new ZipError(`${name} uses the compression method ${entry.method}, which the engine can't read.`);
        }

        return inflate(data, entry.size);
    }

    return { names: [...entries.keys()], read };
}

/**
 * Checks whether a zip file has an entry whose name ends with `.class`, also after other data like a launch script.
 * Reads only the file's end and its central directory, and returns `false` for a file that isn't a zip file that
 * `openZip` reads.
 */
export async function findClassEntry(file: Blob): Promise<boolean> {
    const tailStart = Math.max(0, file.size - endSize - maxCommentSize);
    const tail = new DataView(await file.slice(tailStart).arrayBuffer());
    const end = findEnd(tail);
    if (end < 0) {
        return false;
    }

    const count = tail.getUint16(end + endFields.count, true);
    const directorySize = tail.getUint32(end + endFields.directorySize, true);
    const directoryStart = tail.getUint32(end + endFields.directoryOffset, true);
    const directoryOffset = directoryStart + findShift(tailStart + end, directoryStart, directorySize);
    if (isZip64(tail, end, count, directoryStart) || directoryOffset + directorySize > file.size) {
        return false;
    }

    try {
        const directory = await file.slice(directoryOffset, directoryOffset + directorySize).bytes();

        return [...readEntries(directory, 0, count).keys()].some(name => name.endsWith('.class'));
    } catch (error) {
        if (error instanceof ZipError) {
            return false;
        }

        throw error;
    }
}
