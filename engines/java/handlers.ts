import { failed, ok, type Reply } from '../../contract/reply';
import type { EngineHandlers } from '../../contract/serve';
import { writeRows } from '../../contract/rows';
import { modifiersOf } from '../../contract/symbols';
import { writeJava } from './decompile';
import { describeTarget, resolveTarget } from './describe';
import { type JavaFile, readFile } from './files';
import manifest from './manifest.json' with { type: 'json' };
import { findUsers } from './references';
import { type JavaRows, listRows } from './rows';
import { listStrings } from './strings';
import { findClassEntry } from './zip';

/** An open file with its rows. */
export type OpenFile = JavaFile & JavaRows;

// the first 4 bytes of a zip file's local header, end record and spanned archive
const zipStarts = ['504b0304', '504b0506', '504b0708'];
const classStart = 'cafebabe';
// the major version of Java 1.1, the oldest class file format
const oldestMajorVersion = 45;
const classHeaderSize = 10;
// the largest file that the engine opens, because the engine reads the whole file into memory and a large WAR's classes
// take a few times its size there
const maxFileBytes = 512 * 1024 * 1024;

// the views whose documents the engine writes
const views = manifest.views.map(view => view.id);

let bytecodeLoad: Promise<typeof import('./bytecode')> | undefined;

// imports the bytecode writer with the disassembler on the first bytecode read because listing a file and its Java
// don't need them, and imports them again after a failed import because the connection can come back
function loadBytecode(): Promise<typeof import('./bytecode')> {
    bytecodeLoad ??= import('./bytecode').catch(error => {
        bytecodeLoad = undefined;
        throw error;
    });

    return bytecodeLoad;
}

function refuseView(view: string): Reply<never> {
    return failed(`The Java engine doesn't have the view ${view}.`);
}

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
export function createJavaHandlers(): EngineHandlers {
    const files = new Map<number, OpenFile>();

    function handleFile<Value>(fileId: number, handle: (file: OpenFile) => Reply<Value>): Reply<Value> {
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
                    files.set(fileId, { ...read.value, ...listRows(read.value) });
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
        provide(fileId) {
            return handleFile(fileId, () => failed("The Java engine doesn't take other files."));
        },
        list(fileId) {
            return handleFile(fileId, ({ rows, note }) => ok({ ...writeRows(rows), note, missingFiles: [] }));
        },
        async read(fileId, key, view, signal) {
            const file = files.get(fileId);
            const row = file?.rows[key];
            if (!file) {
                return refuseFile(fileId);
            }
            if (!views.includes(view)) {
                return refuseView(view);
            }
            if (!row) {
                return failed(`${file.name} doesn't have a symbol with the key ${key}.`);
            }
            if (!modifiersOf(row.flags).includes('document')) {
                return failed(`${row.name} doesn't have its own document.`);
            }

            if (view !== 'bytecode') {
                return writeJava(files, fileId, file.rowKeys[key], signal);
            }

            let bytecode: typeof import('./bytecode');
            try {
                bytecode = await loadBytecode();
            } catch (error) {
                return failed(`The engine can't load the disassembler: ${error instanceof Error ? error.message : error}`);
            }

            return bytecode.writeBytecode(files, fileId, file.rowKeys[key], signal);
        },
        describe(target, view) {
            return views.includes(view) ? ok(describeTarget(files, target)) : refuseView(view);
        },
        resolve(target) {
            return ok(resolveTarget(files, target));
        },
        findReferences(target, view, signal) {
            return views.includes(view) ? ok(findUsers(files, target, signal)) : refuseView(view);
        },
        async listStrings(fileId, signal) {
            const file = files.get(fileId);

            return file ? ok(await listStrings(fileId, file, signal)) : refuseFile(fileId);
        },
    };
}
