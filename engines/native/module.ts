import { fetchBytes, importModule, LoadError } from '../shared/loading';
import type { Decompiled } from './code';
import type { GlueListing } from './rows';

/** The part of Emscripten's file system that the engine uses. */
export interface ModuleFileSystem {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
    rmdir(path: string): void;
    mount(type: unknown, options: { blobs: { name: string; data: Blob }[] }, folder: string): void;
    unmount(folder: string): void;
    filesystems: { WORKERFS: unknown };
}

// the part of the module that `rizin.mjs` makes, with the glue's exports and Emscripten's helpers
interface RizinModule {
    _session_new(): number;
    _session_free(session: number): void;
    _session_open(session: number, path: number): number;
    _session_listing(session: number, maxMembers: number): number;
    _session_prepare(session: number, address: number): number;
    _session_struct(session: number, name: number): number;
    _session_load_pdb(session: number, path: number): number;
    _session_load_names(session: number, path: number, headerPath: number): number;
    _session_describe(session: number, address: number): number;
    _session_cmd(session: number, command: number): number;
    _session_decompile(session: number, address: number): number;
    _session_disassemble(session: number, address: number, size: number, maxBytes: number): number;
    _session_references(session: number, address: number): number;
    _session_strings(session: number, maxStrings: number, maxBytes: number): number;
    _session_code_ranges(session: number): number;
    _session_search_code(session: number, from: number, to: number): void;
    _free(pointer: number): void;
    stringToNewUTF8(text: string): number;
    UTF8ToString(pointer: number): string;
    HEAPU8: Uint8Array;
    FS: ModuleFileSystem;
}

type CreateRizin = (options: { wasmBinary?: ArrayBuffer; print: (text: string) => void; printErr: (text: string) => void }) => Promise<RizinModule>;

/** The result of a PDB file's load, in the order of the glue's numbers. */
export type PdbLoad = 'loaded' | 'unreadable' | 'mismatch';

const pdbLoads: PdbLoad[] = ['loaded', 'unreadable', 'mismatch'];

/** A function that the glue analyzed, with the bytes of its code, the name that its C has and its signature. */
export interface PreparedFunction {
    addr: string;
    size: number;
    name: string;
    signature: string;
}

/** An instruction as the glue writes it, with its address and jump target in hex and its text with names. */
export interface GlueInstruction {
    addr: string;
    size: number;
    text: string;
    /** The instruction's text without names, like `call 0x1a20`. */
    opcode: string;
    jump?: string;
}

/** Rizin with rz-ghidra in wasm, with typed calls of the engine's glue. */
export interface NativeModule {
    fs: ModuleFileSystem;
    /** Starts a session with its own Rizin core and returns its pointer, or 0 when the module's memory ran out. */
    newSession(): number;
    freeSession(session: number): void;
    /** Opens a file of the module's file system in a session and returns whether Rizin reads the file's format. */
    openSession(session: number, path: string): boolean;
    /**
     * Lists the symbols of a session's file for `groupRows`, with at most `maxMembers` functions and globals and as many
     * imports.
     */
    listSymbols(session: number, maxMembers: number): GlueListing;
    /** Analyzes the function at an address for the decompiler, or returns `undefined` where Rizin doesn't find one. */
    prepareFunction(session: number, address: bigint): PreparedFunction | undefined;
    /**
     * Loads the names and types of a PDB file into a session and returns `loaded`, or why it didn't: `unreadable` or
     * `mismatch` for a PDB file of another binary.
     */
    loadPdb(session: number, path: string): PdbLoad;
    /**
     * Loads a file with a line for each function, its address relative to the image in hex, its name and an optional
     * signature after a tab, into a session with the C header of the signatures' types, and returns `loaded`, or why
     * it didn't, like `loadPdb`.
     */
    loadNames(session: number, path: string, headerPath?: string): PdbLoad;
    /**
     * Returns the signature of the function at an address from its debug information or its demangled name, or
     * `undefined` where neither has the parameters.
     */
    describeFunction(session: number, address: bigint): string | undefined;
    /** Returns the C definition of a struct of the debug information, or `undefined` for a name without one. */
    describeStruct(session: number, name: string): string | undefined;
    /** Reads a file beside `rizin.mjs`, like `sleigh/files.txt`. */
    fetchFile(path: string): Promise<Uint8Array>;
    /** Decompiles the function at an address with Ghidra and returns its C with rz-ghidra's annotations. */
    decompile(session: number, address: bigint): Decompiled;
    /**
     * Disassembles the instructions of `size` bytes from an address until their bytes reach `maxBytes`, or returns an
     * empty list where the module can't read the bytes.
     */
    disassemble(session: number, address: bigint, size: number, maxBytes: number): GlueInstruction[];
    /** Returns the ranges of the code that Rizin searches for references, each from its start to its end. */
    listCodeRanges(session: number): [from: bigint, to: bigint][];
    /** Searches the code of a range for references, which `listReferences` then finds. */
    searchCode(session: number, from: bigint, to: bigint): void;
    /** Returns the addresses of the code and data that refer to an address, in address order. */
    listReferences(session: number, address: bigint): bigint[];
    /** Returns the first `maxStrings` strings of a session's file, each cut after `maxBytes` bytes of UTF-8. */
    listStrings(session: number, maxStrings: number, maxBytes: number): { addr: string; text: string }[];
    /** Runs a Rizin command in a session and returns its output. */
    runCommand(session: number, command: string): string;
    /** Returns the size of the module's wasm memory, which never shrinks. */
    readMemoryBytes(): number;
}

// reads a string that the glue returns and frees it, because the glue gives each result's ownership to its caller
function takeText(module: RizinModule, pointer: number): string {
    if (pointer === 0) {
        return '';
    }

    try {
        return module.UTF8ToString(pointer);
    } finally {
        module._free(pointer);
    }
}

// reads the JSON that the glue returns, or throws a module error that names what the engine couldn't read, because
// a file with millions of symbols can give a text above the size of a JavaScript string. Makes the call outside the
// `try` because a trap leaves the module broken and has to restart the worker.
function takeJson<T>(module: RizinModule, what: string, call: () => number): T {
    const pointer = call();

    try {
        return JSON.parse(takeText(module, pointer));
    } catch (error) {
        throw new LoadError(`The native engine couldn't read ${what}: ${error instanceof Error ? error.message : error}`);
    }
}

// passes a text to the glue as a C string, which only lives during the call
function withText<T>(module: RizinModule, text: string, call: (pointer: number) => T): T {
    const pointer = module.stringToNewUTF8(text);
    try {
        return call(pointer);
    } finally {
        module._free(pointer);
    }
}

/**
 * Loads `rizin.mjs` from its URL with the bytes of `rizin.wasm` when they're given, else the module fetches the wasm
 * beside itself. Imports the module by its URL at run time because a bundle then leaves its 10 MB out.
 */
export async function loadModule(moduleUrl: string, wasmBinary?: ArrayBuffer): Promise<NativeModule> {
    const { default: createRizin } = await importModule<{ default: CreateRizin }>(moduleUrl, 'rizin.mjs', 'native');

    // drops Rizin's log, whose warnings are about the analysis's guesses and would fill the console of every file
    const module = await createRizin({ wasmBinary, print: () => {}, printErr: () => {} });

    return {
        fs: module.FS,
        newSession: () => module._session_new(),
        freeSession: session => module._session_free(session),
        openSession: (session, path) => withText(module, path, text => module._session_open(session, text) !== 0),
        listSymbols: (session, maxMembers) => takeJson(module, 'the symbols of the file', () => module._session_listing(session, maxMembers)),
        prepareFunction(session, address) {
            const text = withText(module, `0x${address.toString(16)}`, pointer => takeText(module, module._session_prepare(session, pointer)));

            return text === '' ? undefined : JSON.parse(text);
        },
        loadPdb: (session, path) => pdbLoads[withText(module, path, pointer => module._session_load_pdb(session, pointer))],
        loadNames(session, path, headerPath = '') {
            const load = withText(module, path, pointer => {
                return withText(module, headerPath, header => module._session_load_names(session, pointer, header));
            });

            return pdbLoads[load];
        },
        describeFunction(session, address) {
            const text = withText(module, `0x${address.toString(16)}`, pointer => takeText(module, module._session_describe(session, pointer)));

            return text || undefined;
        },
        describeStruct(session, name) {
            return withText(module, name, pointer => takeText(module, module._session_struct(session, pointer))) || undefined;
        },
        decompile(session, address) {
            return withText(module, `0x${address.toString(16)}`, pointer => {
                return takeJson(module, 'the C of the function', () => module._session_decompile(session, pointer));
            });
        },
        disassemble(session, address, size, maxBytes) {
            const text = withText(module, `0x${address.toString(16)}`, pointer => {
                return takeText(module, module._session_disassemble(session, pointer, size, maxBytes));
            });

            return text === '' ? [] : JSON.parse(text);
        },
        listReferences(session, address) {
            const references = withText(module, `0x${address.toString(16)}`, pointer => {
                return takeJson<string[]>(module, 'the references', () => module._session_references(session, pointer));
            });

            return references.map(reference => BigInt(reference));
        },
        listCodeRanges(session) {
            const ranges = takeJson<[string, string][]>(module, 'the ranges of the code', () => module._session_code_ranges(session));

            return ranges.map(([from, to]) => [BigInt(from), BigInt(to)]);
        },
        searchCode(session, from, to) {
            withText(module, `0x${from.toString(16)}`, start => {
                withText(module, `0x${to.toString(16)}`, end => module._session_search_code(session, start, end));
            });
        },
        listStrings(session, maxStrings, maxBytes) {
            return takeJson(module, 'the strings of the file', () => module._session_strings(session, maxStrings, maxBytes));
        },
        fetchFile: path => fetchBytes(new URL(path, moduleUrl), path, 'native'),
        runCommand: (session, command) => withText(module, command, text => takeText(module, module._session_cmd(session, text))),
        readMemoryBytes: () => module.HEAPU8.length,
    };
}
