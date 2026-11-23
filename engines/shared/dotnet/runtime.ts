import type { DotnetExports } from '../../dotnet/runtime';
import type { Il2CppExports } from '../../il2cpp/runtime';

/** The exports of the C# project's assembly, which both the .NET engine and the IL2CPP engine call. */
export interface AssemblyExports {
    Decomp: { Dotnet: { Exports: DotnetExports }; Il2Cpp: { Exports: Il2CppExports } };
}

/** The .NET runtime in wasm with the exports of the C# project's assembly. */
export interface AssemblyRuntime {
    exports: AssemblyExports;
    /** Returns the size of the runtime's wasm memory, which never shrinks. */
    readMemoryBytes(): number;
}

// the part of `dotnet.js` that the engines use
interface DotnetModule {
    dotnet: {
        create(): Promise<{
            getAssemblyExports(assembly: string): Promise<AssemblyExports>;
            getConfig(): { mainAssemblyName: string };
            Module: { HEAPU8: Uint8Array };
        }>;
    };
}

// keeps one runtime for each URL because `dotnet.js` only loads its native module once in a process
const runtimes = new Map<string, Promise<AssemblyRuntime>>();

async function startRuntime(dotnetUrl: string): Promise<AssemblyRuntime> {
    const { dotnet }: DotnetModule = await import(dotnetUrl);
    const { getAssemblyExports, getConfig, Module } = await dotnet.create();
    const exports = await getAssemblyExports(getConfig().mainAssemblyName);

    return { exports, readMemoryBytes: () => Module.HEAPU8.length };
}

/**
 * Loads the .NET runtime from the URL of its `dotnet.js` on the first call and returns the same runtime after that.
 * Forgets a failed load, so the next call loads again, because the connection can come back.
 */
export function loadAssemblyRuntime(dotnetUrl: string): Promise<AssemblyRuntime> {
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

/** The .NET runtime in wasm with the exports of 1 engine's C# class. */
export interface EngineRuntime<Exports> {
    exports: Exports;
    /** Returns the size of the runtime's wasm memory, which never shrinks. */
    readMemoryBytes(): number;
}

// the runtime of each engine by its URL and the function that picks its exports
const engineRuntimes = new Map<string, Map<unknown, Promise<EngineRuntime<unknown>>>>();

/**
 * Loads the runtime like `loadAssemblyRuntime` with the exports that `pickExports` takes from the assembly's, and
 * returns the same runtime for each call with the URL and the function. Forgets a failed load like
 * `loadAssemblyRuntime`.
 */
export function loadEngineRuntime<Exports>(dotnetUrl: string, pickExports: (exports: AssemblyExports) => Exports): Promise<EngineRuntime<Exports>> {
    const runtimes = engineRuntimes.get(dotnetUrl) ?? new Map<unknown, Promise<EngineRuntime<unknown>>>();
    engineRuntimes.set(dotnetUrl, runtimes);
    let runtime = runtimes.get(pickExports) as Promise<EngineRuntime<Exports>> | undefined;
    if (!runtime) {
        runtime = loadAssemblyRuntime(dotnetUrl).then(({ exports, readMemoryBytes }) => ({ exports: pickExports(exports), readMemoryBytes }));
        runtime.catch(() => runtimes.delete(pickExports));
        runtimes.set(pickExports, runtime);
    }

    return runtime;
}
