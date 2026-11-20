/** The part of Emscripten's file system that the engine uses. */
export interface ModuleFileSystem {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
}

// the part of the module that `rizin.mjs` makes, with the glue's exports and Emscripten's helpers
interface RizinModule {
    _session_new(): number;
    _session_free(session: number): void;
    _session_cmd(session: number, command: number): number;
    _free(pointer: number): void;
    stringToNewUTF8(text: string): number;
    UTF8ToString(pointer: number): string;
    HEAPU8: Uint8Array;
    FS: ModuleFileSystem;
}

type CreateRizin = (options: { wasmBinary?: ArrayBuffer }) => Promise<RizinModule>;

/** Rizin with rz-ghidra in wasm, with typed calls of the engine's glue. */
export interface NativeModule {
    fs: ModuleFileSystem;
    /** Starts a session with its own Rizin core and returns its pointer, or 0 when the module's memory ran out. */
    newSession(): number;
    freeSession(session: number): void;
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

    const text = module.UTF8ToString(pointer);
    module._free(pointer);

    return text;
}

/**
 * Loads `rizin.mjs` from its URL with the bytes of `rizin.wasm` when they're given, else the module fetches the wasm
 * beside itself. Imports the module by its URL at run time because a bundle then leaves its 10 MB out.
 */
export async function loadModule(moduleUrl: string, wasmBinary?: ArrayBuffer): Promise<NativeModule> {
    const { default: createRizin }: { default: CreateRizin } = await import(moduleUrl);
    const module = await createRizin({ wasmBinary });

    return {
        fs: module.FS,
        newSession: () => module._session_new(),
        freeSession: session => module._session_free(session),
        runCommand(session, command) {
            const text = module.stringToNewUTF8(command);
            try {
                return takeText(module, module._session_cmd(session, text));
            } finally {
                module._free(text);
            }
        },
        readMemoryBytes: () => module.HEAPU8.length,
    };
}
