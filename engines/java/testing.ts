import { crc32, deflateRawSync } from 'node:zlib';

/** An entry of a zip file that `zipFile` writes. */
export interface ZipEntry {
    name: string;
    bytes: Uint8Array;
    /** Whether the entry's bytes are stored as they are, not deflated. */
    stored?: boolean;
    /** Values that replace the entry's real flags, method and size, for damaged and hostile files. */
    flags?: number;
    method?: number;
    size?: number;
}

/**
 * Writes a zip file with the entries in their order and with zero timestamps, so the same entries give the same bytes.
 */
export function zipFile(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
    const locals: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;

    for (const { name, bytes, stored = false, flags = 0, method = stored ? 0 : 8, size = bytes.length } of entries) {
        const nameBytes = Buffer.from(name);
        const data = stored ? Buffer.from(bytes) : deflateRawSync(bytes);

        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(flags, 6);
        header.writeUInt16LE(method, 8);
        header.writeUInt32LE(crc32(bytes), 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(size, 22);
        header.writeUInt16LE(nameBytes.length, 26);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        header.copy(entry, 8, 6, 26);
        entry.writeUInt16LE(nameBytes.length, 28);
        entry.writeUInt32LE(offset, 42);

        locals.push(header, nameBytes, data);
        directory.push(entry, nameBytes);
        offset += header.length + nameBytes.length + data.length;
    }

    const directoryBytes = Buffer.concat(directory);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directoryBytes.length, 12);
    end.writeUInt32LE(offset, 16);

    return new Uint8Array(Buffer.concat([...locals, directoryBytes, end]));
}
