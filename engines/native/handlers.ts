import { type Document, formatTarget, parseTarget } from '#contract/document';
import { failed, ok, type Reply } from '#contract/reply';
import { writeRows } from '#contract/rows';
import type { EngineHandlers } from '#contract/serve';
import { modifiersOf } from '#contract/symbols';
import { matchesBinary } from '../shared/binary-identity';
import { loadOnce, refuseLoadErrors } from '../shared/loading';
import { isPeFile } from '../shared/pe';
import { createRefusals } from '../shared/refusals';
import { findSection, listSections, readAddress, type Section } from './addresses';
import { assemblyHeader, cHeader, listClassParts, writeClassDocument } from './class-document';
import { createDocumentCache, decompileAt, decompileFunction } from './code';
import { describeRow, findFullName } from './describe';
import { checkArchitecture, disassembleFunction, type DisassemblyRows } from './disassembly';
import { type MountedFile, type MountFile, writeShareFiles } from './files';
import { claimsNativeFile, findRefusal } from './formats';
import manifest from './manifest.json' with { type: 'json' };
import type { NativeModule } from './module';
import { namesFileName, readNamesFile } from './names-file';
import { defaultMaxMembers, groupRows, type NativeRows } from './rows';
import { createLanguageWriter, findProcessor, writeLanguageEarly } from './sleigh';
import { listStrings } from './strings';
import { createFunctionFinder, type FindFunction, findUsers, searchCode, splitCode } from './users';

/** The rows of an open file with each row's index by its key and the function that finds a function by an address. */
interface FileListing extends NativeRows {
    indexes: Map<number, number>;
    findFunction: FindFunction;
}

/** A file that the engine opened, with its Rizin session, its PDB file and its rows once a call needs them. */
interface NativeFile {
    name: string;
    /** The file that the engine opened, which a names file's `Binary` field has to match. */
    binary: Blob;
    session: number;
    mounted: MountedFile;
    pdb?: MountedFile;
    listing?: FileListing;
    /** The parts of the file's code that Rizin didn't search for references yet, once a call needs the references. */
    unsearched?: [from: bigint, to: bigint][];
    /** The address that the image loads at, once `readCode` needs it. */
    base?: bigint;
    /** The sections of the image, once a call needs an address without a row. */
    sections?: Section[];
    /** The sections of the image for `readAddress`, which reads an address without the file's listing. */
    imageSections?: Section[];
}

/** The native engine's handlers with the call that the IL2CPP engine makes in its own worker. */
export interface NativeHandlers extends EngineHandlers {
    /**
     * Decompiles the code at an address relative to the image into C without a row of the file's listing, like a
     * method's code that a game's metadata points at. Each target of the C has the address relative to the image as
     * its key.
     */
    readCode(fileId: number, rva: number, signal: AbortSignal): Promise<Reply<Document>>;
    /**
     * Reads the code at an address relative to the image like `readCode`, or a note with the bytes of the data there,
     * without the file's listing. Refuses an address outside the image's sections.
     */
    readAddress(fileId: number, rva: number, signal: AbortSignal): Promise<Reply<Document>>;
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

/**
 * Returns the native engine's handlers, which load the module with the first call that needs it, because `claims` then
 * only reads the file's headers. Each open file gets a Rizin session. `mountFile` puts the file's bytes where the
 * session reads them.
 */
export function createNativeHandlers(loadModule: () => Promise<NativeModule>, mountFile: MountFile): NativeHandlers {
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

    // loads a names file and its header, whose text the glue reads at once, so the mounted copies go away
    async function provideNames(module: NativeModule, fileId: number, file: NativeFile, name: string, names: Blob): Promise<Reply<void>> {
        const namesFile = await readNamesFile(names, name);
        if (namesFile.error !== undefined) {
            return namesFile;
        }
        if (namesFile.value.binary && !(await matchesBinary(namesFile.value.binary, file.binary))) {
            return failed(`${name} lists the functions of another binary, not of ${file.name}.`);
        }

        return loadNames(module, fileId, file, name, namesFile.value.lines, new Blob([namesFile.value.header ?? '']));
    }

    async function loadNames(module: NativeModule, fileId: number, file: NativeFile, name: string, lines: Blob, header: Blob): Promise<Reply<void>> {
        const mounted = await mountFile(module.fs, `/files/${++mountCount}`, name, lines);
        const mountedHeader = await mountFile(module.fs, `/files/${++mountCount}`, 'il2cpp.h', header);
        const load = module.loadNames(file.session, mounted.path, mountedHeader.path);
        mounted.unmount();
        mountedHeader.unmount();
        if (load !== 'loaded') {
            return failed(load === 'mismatch' ? `${name} doesn't match ${file.name}.` : `${name} isn't readable.`);
        }

        // drops the rows and documents that the names change
        file.listing = undefined;
        cache.dropFile(fileId);

        return ok(undefined);
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
    function searchFile(module: NativeModule, file: NativeFile, signal: AbortSignal): Promise<void> {
        file.unsearched ??= splitCode(module.listCodeRanges(file.session));

        return searchCode(module, file.session, file.unsearched, signal);
    }

    // writes the languages of a file's processor before its first C, because Ghidra needs them and Rizin disassembles a
    // processor that Ghidra doesn't decompile
    async function writeFileLanguage({ module, writeLanguage }: LoadedModule, file: NativeFile, signal: AbortSignal): Promise<Reply<void>> {
        const processor = findProcessor(module, file.session);
        if (processor.error !== undefined) {
            return processor;
        }

        await writeLanguage(processor.value);
        signal.throwIfAborted();

        return ok(undefined);
    }

    function readBase(module: NativeModule, file: NativeFile): bigint {
        file.base ??= BigInt(JSON.parse(module.runCommand(file.session, 'iIj')).baddr ?? 0);

        return file.base;
    }

    // finds the section of an address without a row in an image whose keys are the addresses' offsets from its base
    function findAddressSection(module: NativeModule, file: NativeFile, key: number): Section | undefined {
        if (!file.sections) {
            const base = readBase(module, file);
            const isOffsetKeyed = [...readListing(module, file).keys.addresses].every(([found, address]) => BigInt(found) === address - base);
            file.sections = isOffsetKeyed ? listSections(module, file.session, base) : [];
        }

        return findSection(file.sections, key);
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

            // skips a PE file's base relocations, which only patch an image that loads at another address than its
            // own, because Rizin loads it at its own and a game's binary takes a second and 170 MB for its 500,000
            if (await isPeFile(file)) {
                module.runCommand(session, 'e bin.relocs=false');
            }

            const refusal = findRefusal(module, session, mounted.path, name);
            if (refusal !== undefined) {
                module.freeSession(session);
                mounted.unmount();
                return failed(refusal);
            }

            files.set(fileId, { name, binary: file, session, mounted });
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
            if (!readListing(module, file).missingFiles.some(missingFile => missingFile.name === name && missingFile.isCompanion)) {
                return failed(`${file.name} doesn't need ${name}.`);
            }

            if (name === namesFileName) {
                return provideNames(module, fileId, file, name, pdb);
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

            const loaded = await useLoaded();
            const { module } = loaded;
            signal.throwIfAborted();

            const file = found.value;
            const listing = readListing(module, file);
            const index = listing.indexes.get(key);
            const section = index === undefined && view === 'c' ? findAddressSection(module, file, key) : undefined;
            if (section) {
                return readAddress(module, file.session, fileId, readBase(module, file), key, section);
            }
            if (index === undefined) {
                return refusals.key(file.name, `0x${(key >>> 0).toString(16)}`);
            }
            if (!modifiersOf(listing.rows[index].flags).includes('document')) {
                return refusals.noDocument(listing.rows[index].name);
            }

            const architecture = view === 'assembly' ? checkArchitecture(module, file.session) : ok(undefined);
            if (architecture.error !== undefined) {
                return architecture;
            }

            const language = view === 'c' ? await writeFileLanguage(loaded, file, signal) : ok(undefined);
            if (language.error !== undefined) {
                return language;
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

            return writeClassDocument(parts, readMethod, signal, view === 'c' ? cHeader : assemblyHeader);
        },
        async readCode(fileId, rva, signal) {
            const found = findFile(fileId);
            if (found.error !== undefined) {
                return found;
            }

            const loaded = await useLoaded();
            const file = found.value;
            const language = await writeFileLanguage(loaded, file, signal);
            if (language.error !== undefined) {
                return language;
            }

            const base = readBase(loaded.module, file);

            return decompileAt(loaded.module, file.session, fileId, base, rva);
        },
        async readAddress(fileId, rva, signal) {
            const found = findFile(fileId);
            if (found.error !== undefined) {
                return found;
            }

            const loaded = await useLoaded();
            const file = found.value;
            const base = readBase(loaded.module, file);
            file.imageSections ??= listSections(loaded.module, file.session, base);
            const section = findSection(file.imageSections, rva);
            if (!section) {
                return refusals.key(file.name, `0x${rva.toString(16)}`);
            }

            const language = section.isCode ? await writeFileLanguage(loaded, file, signal) : ok(undefined);

            return language.error === undefined ? readAddress(loaded.module, file.session, fileId, base, rva, section) : language;
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
        // resolves an address without a row too, like a function that only a call names, which `read` decompiles
        async resolve(target) {
            const parsed = parseTarget(target);
            const file = 'fileId' in parsed ? files.get(parsed.fileId) : undefined;
            const isAddress = file !== undefined && 'key' in parsed && findAddressSection(await useModule(), file, parsed.key) !== undefined;

            return ok(isAddress || (await findTarget(target)) ? target : null);
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
            await searchFile(module, found.file, signal);
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
            await searchFile(module, file, signal);

            return ok(await listStrings(module, file.session, fileId, readListing(module, file).findFunction, signal));
        },
    });
}
