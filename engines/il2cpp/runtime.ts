import { type AssemblyExports, type EngineRuntime, loadEngineRuntime } from '../shared/dotnet/runtime';

/** The methods of the C# class `Decomp.Il2Cpp.Exports`. */
export interface Il2CppExports {
    Reset(): void;
    /** Reads the metadata and keeps it under the file id for the stubs. */
    ReadMetadata(fileId: number, name: string, metadata: Uint8Array): Uint8Array;
    /**
     * Reads the game from the metadata that `ReadMetadata` kept under the file id and the binary, and keeps it for the
     * stubs. Tries the layout of the Unity version that read the metadata first.
     */
    ReadGame(fileId: number, name: string, binaryName: string, binary: Uint8Array): Uint8Array;
    Close(fileId: number): void;
    /**
     * Writes the C# of a type with the .NET engine's decompiler, as the JSON of the .NET engine's document reply with
     * the places of the methods' empty bodies. Each accessor gets an empty body too when `expandsAccessors` is set.
     */
    ReadCSharp(fileId: number, typeIndex: number, expandsAccessors: boolean): string;
    /** Describes the type or member of a row key, as the JSON of a reply with the description or `null`. */
    Describe(fileId: number, key: number): string;
}

/** The .NET runtime in wasm with the engine's exports. */
export type Il2CppRuntime = EngineRuntime<Il2CppExports>;

const pickExports = (exports: AssemblyExports) => exports.Decomp.Il2Cpp.Exports;

/** Loads the .NET runtime from the URL of its `dotnet.js` on the first call and returns the same runtime after that. */
export function loadRuntime(dotnetUrl: string): Promise<Il2CppRuntime> {
    return loadEngineRuntime(dotnetUrl, pickExports);
}
