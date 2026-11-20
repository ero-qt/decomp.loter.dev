/** The methods of the C# class `Decomp.Dotnet.Exports`. */
export interface DotnetExports {
    Reset(): void;
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

// keeps one runtime for each URL because `dotnet.js` loads its native module only once in a process
const runtimes = new Map<string, Promise<DotnetRuntime>>();

async function startRuntime(dotnetUrl: string): Promise<DotnetRuntime> {
    const { dotnet }: DotnetModule = await import(dotnetUrl);
    const { getAssemblyExports, getConfig, Module } = await dotnet.create();
    const exports = await getAssemblyExports(getConfig().mainAssemblyName);

    return { exports: exports.Decomp.Dotnet.Exports, readMemoryBytes: () => Module.HEAPU8.length };
}

/** Loads the .NET runtime from the URL of its `dotnet.js` on the first call and returns the same runtime after that. */
export function loadRuntime(dotnetUrl: string): Promise<DotnetRuntime> {
    let runtime = runtimes.get(dotnetUrl);
    if (!runtime) {
        runtime = startRuntime(dotnetUrl);
        runtimes.set(dotnetUrl, runtime);
    }

    return runtime;
}
