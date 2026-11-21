/** The methods of the C# class `Decomp.Dotnet.Exports`. */
export interface DotnetExports {
    Reset(): void;
    Open(fileId: number, name: string, bytes: Uint8Array): string;
    Close(fileId: number): string;
    List(fileId: number): Promise<string>;
    ReadCSharp(fileId: number, key: number): Promise<string>;
    ReadIl(fileId: number, key: number): Promise<string>;
    Describe(target: string, view: string): string;
    Resolve(target: string): string;
    FindUsers(target: string): Promise<string>;
    ListStrings(fileId: number): Promise<string>;
    Cancel(): void;
}

/** The .NET runtime in wasm with the engine's exports. */
export interface DotnetRuntime {
    exports: DotnetExports;
    /** Returns the size of the runtime's wasm memory, which never shrinks. */
    readMemoryBytes(): number;
}

// the part of `dotnet.js` that the engine uses
interface DotnetModule {
    dotnet: {
        create(): Promise<{
            getAssemblyExports(assembly: string): Promise<{ Decomp: { Dotnet: { Exports: DotnetExports } } }>;
            getConfig(): { mainAssemblyName: string };
            Module: { HEAPU8: Uint8Array };
        }>;
    };
}

// keeps one runtime for each URL because `dotnet.js` only loads its native module once in a process
const runtimes = new Map<string, Promise<DotnetRuntime>>();

async function startRuntime(dotnetUrl: string): Promise<DotnetRuntime> {
    const { dotnet }: DotnetModule = await import(dotnetUrl);
    const { getAssemblyExports, getConfig, Module } = await dotnet.create();
    const exports = await getAssemblyExports(getConfig().mainAssemblyName);

    return { exports: exports.Decomp.Dotnet.Exports, readMemoryBytes: () => Module.HEAPU8.length };
}

/**
 * Loads the .NET runtime from the URL of its `dotnet.js` on the first call and returns the same runtime after that.
 * Forgets a failed load, so the next call loads again, because the connection can come back.
 */
export function loadRuntime(dotnetUrl: string): Promise<DotnetRuntime> {
    let runtime = runtimes.get(dotnetUrl);
    if (!runtime) {
        runtime = startRuntime(dotnetUrl).catch((error: unknown) => {
            runtimes.delete(dotnetUrl);
            throw error;
        });
        runtimes.set(dotnetUrl, runtime);
    }

    return runtime;
}
