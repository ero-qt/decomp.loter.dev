import { type Document, formatTarget, parseTarget } from '../../contract/document';
import { failed, ok, type Reply } from '../../contract/reply';
import { writeRows } from '../../contract/rows';
import type { EngineHandlers } from '../../contract/serve';
import { modifiersOf } from '../../contract/symbols';
import { loadOnce, refuseLoadErrors } from '../shared/loading';
import { createRefusals } from '../shared/refusals';
import { cHeader, disassemblyHeader, listClassParts, writeClassDocument } from './class-document';
import { createDocumentCache, decompileFunction } from './code';
import { describeRow, findFullName } from './describe';
import { checkArchitecture, disassembleFunction, type DisassemblyRows } from './disassembly';
import { type MountedFile, type MountFile, writeShareFiles } from './files';
import { claimsNativeFile } from './formats';
import manifest from './manifest.json' with { type: 'json' };
import type { NativeModule } from './module';
import { defaultMaxMembers, groupRows, type NativeRows } from './rows';
import { createLanguageWriter, findProcessor } from './sleigh';
import { listStrings } from './strings';
import { createFunctionFinder, type FindFunction, findUsers } from './users';

/** The rows of an open file with each row's index by its key and the function that finds a function by an address. */
interface FileListing extends NativeRows {
    indexes: Map<number, number>;
    findFunction: FindFunction;
}

/** A file that the engine opened, with its Rizin session, its PDB file and its rows once a call needs them. */
interface NativeFile {
    name: string;
    session: number;
    mounted: MountedFile;
    pdb?: MountedFile;
    listing?: FileListing;
    /** Whether Rizin searched the file's code for references, which it does once. */
    isSearched?: boolean;
}

/** The loaded module with the function that writes a processor's languages before its first decompile. */
interface LoadedModule {
    module: NativeModule;
    writeLanguage: (processor?: string) => Promise<void>;
}

// the views whose documents the engine writes
const views = manifest.views.map(view => view.id);
const refusals = createRefusals('native');

// counts the files that any handlers mounted, because a module outlives its handlers in tests and each file then gets
// a folder of its own
let mountCount = 0;

// checks whether a binary only imports from mscoree.dll, like a .NET assembly without its CLI header
function isManagedStub(module: NativeModule, session: number): boolean {
    const imports: { libname?: string }[] = JSON.parse(module.runCommand(session, 'iij') || '[]');

    return imports.length > 0 && imports.every(({ libname }) => /^mscoree\.dll$/i.test(libname ?? ''));
}

// returns why the engine can't read the binary of a session's open file, or `undefined` for a binary that it reads
function findRefusal(module: NativeModule, session: number, path: string, name: string): string | undefined {
    if (!module.openSession(session, path)) {
        return `${name} isn't a readable ELF, PE or Mach-O file.`;
    }
    if (isManagedStub(module, session)) {
        return `${name} only imports mscoree.dll, so its code is .NET IL and not machine code.`;
    }

    return undefined;
}

// starts writing the languages of a session's processor without waiting for them, because the first decompile then
// doesn't wait for their fetch. A failed write gets ignored here because that decompile writes the languages again.
function writeLanguageEarly(writeLanguage: (processor?: string) => Promise<void>, module: NativeModule, session: number) {
    const processor = findProcessor(module, session);
    if (processor.value !== undefined) {
        writeLanguage(processor.value).catch(() => undefined);
    }
}

/**
 * Returns the native engine's handlers, which load the module with the first call that needs it, because `claims` then
 * only reads the file's headers. Each open file gets a Rizin session. `mountFile` puts the file's bytes where the
 * session reads them.
 */
export function createNativeHandlers(loadModule: () => Promise<NativeModule>, mountFile: MountFile): EngineHandlers {
    const files = new Map<number, NativeFile>();
    const cache = createDocumentCache();

    // writes the databases and the language list before the first session, because Rizin reads the databases when it
    // loads a binary and a session's Ghidra plugin doesn't see languages that come later
    async function loadAndWrite(): Promise<LoadedModule> {
        const module = await loadModule();
        const writeLanguage = createLanguageWriter(module);
        await Promise.all([writeShareFiles(module), writeLanguage()]);

        return { module, writeLanguage };
    }

    const useLoaded = loadOnce(loadAndWrite);

    async function useModule(): Promise<NativeModule> {
        return (await useLoaded()).module;
    }

    function readListing(module: NativeModule, file: NativeFile): FileListing {
        if (!file.listing) {
            const listed = groupRows(module.listSymbols(file.session, defaultMaxMembers));
            const indexes = new Map(listed.rows.map((row, index) => [row.key, index]));
            file.listing = { ...listed, indexes, findFunction: createFunctionFinder(listed) };
        }

        return file.listing;
    }

    // finds the row of a function, global or import at an address, whose import's address is its stub or pointer
    function findRows(fileId: number, address: bigint, listing: FileListing): DisassemblyRows {
        const { rows, keys, importKeys, indexes } = listing;

        return {
            fileId,
            address,
            findRow(at) {
                const key = keys.keys.get(at) ?? importKeys.get(at);
                const index = key === undefined ? undefined : indexes.get(key)!;

                return index === undefined ? undefined : { key: rows[index].key, kind: rows[index].kind, name: findFullName(listing, index) };
            },
        };
    }

    // decompiles the function of a row once and takes it from the cache after that
    function readFunction(module: NativeModule, fileId: number, file: NativeFile, listing: FileListing, key: number): Reply<Document> {
        const cached = cache.get(fileId, key);
        if (cached) {
            return ok(cached);
        }

        const { kind } = listing.rows[listing.indexes.get(key)!];
        const reply = decompileFunction(module, file.session, kind, findRows(fileId, listing.keys.addresses.get(key)!, listing));
        if (reply.value) {
            cache.set(fileId, key, reply.value);
        }

        return reply;
    }

    // finds the open file and the row of a row target, or returns `undefined` for any other target
    async function findTarget(target: string): Promise<{ fileId: number; file: NativeFile; listing: FileListing; index: number } | undefined> {
        const parsed = parseTarget(target);
        const file = 'fileId' in parsed ? files.get(parsed.fileId) : undefined;
        if (!file || !('fileId' in parsed)) {
            return undefined;
        }

        const listing = readListing(await useModule(), file);
        const index = listing.indexes.get(parsed.key);

        return index === undefined ? undefined : { fileId: parsed.fileId, file, listing, index };
    }

    // searches a file's code for references once, because Rizin only finds a reference in searched code
    function searchCode(module: NativeModule, file: NativeFile) {
        if (!file.isSearched) {
            module.runCommand(file.session, 'aar');
            file.isSearched = true;
        }
    }

    function findFile(fileId: number): Reply<NativeFile> {
        const file = files.get(fileId);

        return file ? ok(file) : refusals.file(fileId);
    }

    return refuseLoadErrors({
        async claims(_, file) {
            return ok(await claimsNativeFile(file));
        },
        async open(fileId, name, file, signal) {
            const { module, writeLanguage } = await useLoaded();
            signal.throwIfAborted();

            const mounted = await mountFile(module.fs, `/files/${++mountCount}`, 'binary', file);
            const session = module.newSession();
            if (session === 0) {
                mounted.unmount();
                return failed(`The engine ran out of memory before it opened ${name}.`);
            }

            const refusal = findRefusal(module, session, mounted.path, name);
            if (refusal !== undefined) {
                module.freeSession(session);
                mounted.unmount();
                return failed(refusal);
            }

            files.set(fileId, { name, session, mounted });
            writeLanguageEarly(writeLanguage, module, session);

            return ok(undefined);
        },
        async close(fileId) {
            const found = findFile(fileId);
            if (found.error !== undefined) {
                return found;
            }

            (await useModule()).freeSession(found.value.session);
            found.value.mounted.unmount();
            found.value.pdb?.unmount();
            files.delete(fileId);
            cache.dropFile(fileId);

            return ok(undefined);
        },
        async provide(fileId, name, pdb, signal) {
            const found = findFile(fileId);
            if (found.error !== undefined) {
                return found;
            }

            const module = await useModule();
            signal.throwIfAborted();

            const file = found.value;
            if (!readListing(module, file).missingFiles.some(missingFile => missingFile.name === name)) {
                return failed(`${file.name} doesn't need ${name}.`);
            }

            const mounted = await mountFile(module.fs, `/files/${++mountCount}`, name, pdb);
            const load = module.loadPdb(file.session, mounted.path);
            if (load !== 'loaded') {
                mounted.unmount();
                return failed(load === 'mismatch' ? `${name} doesn't match ${file.name}.` : `${name} isn't a readable PDB file.`);
            }

            // drops the rows and documents that the names and types of the PDB file change
            file.pdb = mounted;
            file.listing = undefined;
            cache.dropFile(fileId);

            return ok(undefined);
        },
        async list(fileId, signal) {
            const found = findFile(fileId);
            if (found.error !== undefined) {
                return found;
            }

            const module = await useModule();
            signal.throwIfAborted();
            const { rows, note, missingFiles } = readListing(module, found.value);

            return ok({ ...writeRows(rows), note, missingFiles });
        },
        async read(fileId, key, view, signal) {
            const found = findFile(fileId);
            if (found.error !== undefined) {
                return found;
            }
            if (!views.includes(view)) {
                return refusals.view(view);
            }

            const { module, writeLanguage } = await useLoaded();
            signal.throwIfAborted();

            const file = found.value;
            const listing = readListing(module, file);
            const index = listing.indexes.get(key);
            if (index === undefined) {
                return refusals.key(file.name, `0x${(key >>> 0).toString(16)}`);
            }
            if (!modifiersOf(listing.rows[index].flags).includes('document')) {
                return refusals.noDocument(listing.rows[index].name);
            }

            const architecture = view === 'disassembly' ? checkArchitecture(module, file.session) : ok(undefined);
            if (architecture.error !== undefined) {
                return architecture;
            }

            // writes the languages of the file's processor only for C, because Ghidra needs them and Rizin disassembles
            // a processor that Ghidra doesn't decompile
            if (view === 'c') {
                const processor = findProcessor(module, file.session);
                if (processor.error !== undefined) {
                    return processor;
                }

                await writeLanguage(processor.value);
                signal.throwIfAborted();
            }

            const decompile = (methodKey: number) => readFunction(module, fileId, file, listing, methodKey);
            const disassemble = (methodKey: number) => {
                return disassembleFunction(module, file.session, findRows(fileId, listing.keys.addresses.get(methodKey)!, listing), signal);
            };
            const readMethod = view === 'c' ? decompile : disassemble;
            if (listing.keys.addresses.has(key)) {
                return readMethod(key);
            }

            const parts = listClassParts(listing, index, fileId, name => module.describeStruct(file.session, name));

            return writeClassDocument(parts, readMethod, signal, view === 'c' ? cHeader : disassemblyHeader);
        },
        async describe(target, view, signal) {
            if (!views.includes(view)) {
                return refusals.view(view);
            }

            const found = await findTarget(target);
            signal.throwIfAborted();
            if (!found) {
                return ok(null);
            }

            const { fileId, file, listing, index } = found;
            const module = await useModule();
            const decompiled = cache.get(fileId, listing.rows[index].key)?.text;

            return ok(describeRow(listing, index, address => module.describeFunction(file.session, address), decompiled));
        },
        async resolve(target) {
            return ok((await findTarget(target)) ? target : null);
        },
        // leaves the places of the uses to the page, which finds them in the users' documents, because the C of a user
        // doesn't exist before its decompile
        async findReferences(target, view, signal) {
            if (!views.includes(view)) {
                return refusals.view(view);
            }

            const found = await findTarget(target);
            const address = found?.listing.keys.addresses.get(found.listing.rows[found.index].key);
            if (!found || address === undefined) {
                return ok([]);
            }

            const module = await useModule();
            signal.throwIfAborted();
            searchCode(module, found.file);
            const users = findUsers(module, found.file.session, found.listing.findFunction, address);

            return ok(users.map(key => ({ user: formatTarget({ fileId: found.fileId, key }), ranges: null })));
        },
        async listStrings(fileId, signal) {
            const found = findFile(fileId);
            if (found.error !== undefined) {
                return found;
            }

            const module = await useModule();
            signal.throwIfAborted();
            const file = found.value;
            searchCode(module, file);

            return ok(await listStrings(module, file.session, fileId, readListing(module, file).findFunction, signal));
        },
    });
}
