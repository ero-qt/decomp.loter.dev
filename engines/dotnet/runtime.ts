import { type AssemblyExports, type EngineRuntime, loadEngineRuntime } from '../shared/dotnet/runtime';

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
export type DotnetRuntime = EngineRuntime<DotnetExports>;

const pickExports = (exports: AssemblyExports) => exports.Decomp.Dotnet.Exports;

/**
 * Loads the .NET runtime from the URL of its `dotnet.js` on the first call and returns the same runtime after that.
 * Forgets a failed load, so the next call loads again, because the connection can come back.
 */
export function loadRuntime(dotnetUrl: string): Promise<DotnetRuntime> {
    return loadEngineRuntime(dotnetUrl, pickExports);
}
