import type { Decompiled } from './code';
import type { GlueListing } from './rows';

/** The part of Emscripten's file system that the engine uses. */
export interface ModuleFileSystem {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
    rmdir(path: string): void;
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
    _session_describe(session: number, address: number): number;
    _session_cmd(session: number, command: number): number;
    _session_decompile(session: number, address: number): number;
    _free(pointer: number): void;
    stringToNewUTF8(text: string): number;
    UTF8ToString(pointer: number): string;
    HEAPU8: Uint8Array;
    FS: ModuleFileSystem;
}

type CreateRizin = (options: { wasmBinary?: ArrayBuffer }) => Promise<RizinModule>;

/** The result of a PDB file's load, in the order of the glue's numbers. */
export type PdbLoad = 'loaded' | 'unreadable' | 'mismatch';

const pdbLoads: PdbLoad[] = ['loaded', 'unreadable', 'mismatch'];

/** An error of the module or its files, like a file that didn't load, which the handlers refuse a call with. */
export class ModuleError extends Error {}

/** A function that the glue analyzed, with the bytes of its code, the name that its C has and its signature. */
export interface PreparedFunction {
    addr: string;
    size: number;
    name: string;
    signature: string;
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
// a file with millions of symbols can give a text above the size of a JavaScript string
function takeJson<T>(module: RizinModule, what: string, call: () => number): T {
    try {
        return JSON.parse(takeText(module, call()));
    } catch (error) {
        throw new ModuleError(`The native engine couldn't read ${what}: ${error instanceof Error ? error.message : error}`);
    }
}

// passes a text to the glue as a C string, which lives only during the call
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
    let createRizin: CreateRizin;
    try {
        ({ default: createRizin } = await import(moduleUrl));
    } catch (error) {
        throw new ModuleError(`The native engine couldn't load rizin.mjs: ${error instanceof Error ? error.message : error}`);
    }

    const module = await createRizin({ wasmBinary });

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
        async fetchFile(path) {
            try {
                const response = await fetch(new URL(path, moduleUrl));
                if (!response.ok) {
                    throw new Error(`${response.status} ${response.statusText}`);
                }

                return new Uint8Array(await response.arrayBuffer());
            } catch (error) {
                throw new ModuleError(`The native engine couldn't load ${path}: ${error instanceof Error ? error.message : error}`);
            }
        },
        runCommand: (session, command) => withText(module, command, text => takeText(module, module._session_cmd(session, text))),
        readMemoryBytes: () => module.HEAPU8.length,
    };
}
