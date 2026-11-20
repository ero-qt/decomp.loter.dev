import { failed, ok, type Reply } from '../../contract/reply';
import type { EngineHandlers } from '../../contract/serve';
import { type JavaFile, readFile } from './files';
import { findClassEntry } from './zip';

/** The handlers that the Java engine has so far. */
export type JavaHandlers = Pick<EngineHandlers, 'claims' | 'open' | 'close'>;

// the first 4 bytes of a zip file's local header, end record and spanned archive
const zipStarts = ['504b0304', '504b0506', '504b0708'];
const classStart = 'cafebabe';
// the major version of Java 1.1, the oldest class file format
const oldestMajorVersion = 45;
const classHeaderSize = 10;
// the largest file that the engine opens, because the engine reads the whole file into memory and a large WAR's classes
// take a few times its size there
const maxFileBytes = 512 * 1024 * 1024;

function refuseFile(fileId: number): Reply<never> {
    return failed(`The Java engine doesn't have an open file with the id ${fileId}.`);
}

function toHex(bytes: Uint8Array): string {
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// checks the major version because a fat Mach-O file starts like a class file but has a small count of architectures
// where a class file has its major version
function claimsClass(file: Blob, start: Uint8Array): boolean {
    const major = start.length >= 8 ? new DataView(start.buffer, start.byteOffset).getUint16(6) : 0;

    return file.size >= classHeaderSize && major >= oldestMajorVersion;
}

/** Returns the Java engine's handlers, which keep the open files in memory. */
export function createJavaHandlers(): JavaHandlers {
    const files = new Map<number, JavaFile>();

    function handleFile<Value>(fileId: number, handle: (file: JavaFile) => Reply<Value>): Reply<Value> {
        const file = files.get(fileId);

        return file ? handle(file) : refuseFile(fileId);
    }

    return {
        async claims(name, file) {
            const start = await file.slice(0, 8).bytes();
            const magic = toHex(start.subarray(0, 4));
            if (magic === classStart) {
                return ok(claimsClass(file, start));
            }
            if (/\.[jw]ar$/i.test(name)) {
                return ok(zipStarts.includes(magic) || (await findClassEntry(file)));
            }

            return ok(magic === zipStarts[0] && (await findClassEntry(file)));
        },
        // reads the whole file because a JAR read in parts takes seconds for a few thousand classes
        async open(fileId, name, file, signal) {
            if (file.size > maxFileBytes) {
                return failed(`${name} has more than ${maxFileBytes / 1024 / 1024} MB, which the engine can't open.`);
            }

            try {
                const read = await readFile(name, await file.bytes(), signal);
                if (read.value) {
                    files.set(fileId, read.value);
                }

                return read.error === undefined ? ok(undefined) : read;
            } catch (error) {
                if (error instanceof RangeError) {
                    return failed(`${name} doesn't fit in the engine's memory.`);
                }

                throw error;
            }
        },
        close(fileId) {
            return handleFile(fileId, () => {
                files.delete(fileId);

                return ok(undefined);
            });
        },
    };
}
