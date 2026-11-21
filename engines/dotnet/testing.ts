import { afterEach, beforeEach } from 'bun:test';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Engine } from '../../contract/engine';
import { restoreWorker, useInThreadWorker } from '../../contract/in-thread-worker';
import { connectEngine } from '../../contract/queue';
import { frameworkFolder, publishEngine } from './build';
import { buildFixture, compileText } from './fixture/build';
import { createDotnetHandlers } from './handlers';
import { type DotnetRuntime, loadRuntime } from './runtime';

/** The folder that the tests build the fixture's assemblies into. */
export const fixtureFolder = fileURLToPath(new URL('../../artifacts/dotnet-fixture/', import.meta.url));

const testFolder = fileURLToPath(new URL('../../artifacts/dotnet-test/', import.meta.url));

let fixtureBuild: Promise<void> | undefined;
let runtimeLoad: Promise<DotnetRuntime> | undefined;
let runtime: DotnetRuntime | undefined;

function findDotnet(): string | undefined {
    return Bun.which('dotnet') ?? undefined;
}

/** Reads an assembly of the fixture, like `Drawing.dll`, and builds the fixture first when its stamp is stale. */
export async function readFixture(name: string): Promise<File> {
    fixtureBuild ??= buildFixture(fixtureFolder, findDotnet());
    await fixtureBuild;

    return new File([await Bun.file(join(fixtureFolder, name)).bytes()], name);
}

/**
 * Compiles C# text into an assembly at a path below the tests' folder without `.dll`, like `old/Facade`, with the
 * assemblies at more such paths as references. The assembly's name is the path's last part. A debug build leaves the IL
 * unoptimized.
 */
export async function compileAssembly(path: string, text: string, references: string[] = [], { isDebug = false } = {}): Promise<File> {
    const dotnet = findDotnet();
    if (!dotnet) {
        throw new Error('Install the .NET SDK 11 because the tests compile assemblies with it.');
    }

    const referencePaths = references.map(reference => join(testFolder, `${reference}.dll`));
    const options = { references: referencePaths, isOptimized: !isDebug };
    const assembly = await compileText(dotnet, join(testFolder, dirname(path)), basename(path), text, options);

    return new File([await Bun.file(assembly).bytes()], `${basename(path)}.dll`);
}

async function publishAndLoad(): Promise<DotnetRuntime> {
    await publishEngine();
    runtime = await loadRuntime(pathToFileURL(`${frameworkFolder}/dotnet.js`).href);

    return runtime;
}

/** Publishes the engine when its stamp is stale and loads the published runtime, once in a process. */
export function loadTestRuntime(): Promise<DotnetRuntime> {
    runtimeLoad ??= publishAndLoad();

    return runtimeLoad;
}

/**
 * Serves the .NET engine in an in-thread worker during each test of a file and returns the function that connects a
 * test.
 */
export function useDotnetEngine(): () => Engine {
    beforeEach(() => useInThreadWorker(() => createDotnetHandlers(loadTestRuntime), () => runtime?.readMemoryBytes() ?? 0));
    afterEach(restoreWorker);

    return connectDotnet;
}

/** Connects a test to the .NET engine in the in-thread worker that the test serves. */
export function connectDotnet(): Engine {
    return connectEngine('dotnet.js', { timeLimitMs: 120000, cancelLimitMs: 30000, hasLinkedFiles: true });
}

/** The shape of a PE file that `peFile` writes. */
export interface PeShape {
    /** Whether the optional header is PE32+, which 64-bit files have. */
    is64Bit?: boolean;
    /** Whether the CLI header's data directory has an address and a size, which a native PE file leaves at 0. */
    hasCliHeader?: boolean;
}

/** Writes the headers of a PE file without sections, with the PE header at 0x80 and all 16 data directories. */
export function peFile({ is64Bit = false, hasCliHeader = true }: PeShape): Uint8Array<ArrayBuffer> {
    const headerOffset = 0x80;
    const optionalSize = is64Bit ? 240 : 224;
    const optional = headerOffset + 24;
    const bytes = new Uint8Array(optional + optionalSize);
    const view = new DataView(bytes.buffer);

    bytes.set([0x4d, 0x5a]);
    view.setUint32(0x3c, headerOffset, true);

    bytes.set([0x50, 0x45, 0, 0], headerOffset);
    view.setUint16(headerOffset + 4, is64Bit ? 0x8664 : 0x14c, true);
    view.setUint16(headerOffset + 20, optionalSize, true);

    const directories = optional + (is64Bit ? 112 : 96);
    view.setUint16(optional, is64Bit ? 0x20b : 0x10b, true);
    view.setUint32(directories - 4, 16, true);
    if (hasCliHeader) {
        view.setUint32(directories + 14 * 8, 0x2008, true);
        view.setUint32(directories + 14 * 8 + 4, 72, true);
    }

    return bytes;
}

/**
 * Replaces the only run of bytes from `start` to `end` that matches a pattern, where `undefined` matches any byte, for
 * tests that break 1 part of an assembly. Throws when no run or several runs match.
 */
export function patchBytes(
    bytes: Uint8Array,
    pattern: (number | undefined)[],
    replacement: number[],
    { start = 0, end = bytes.length } = {},
): void {
    const matches: number[] = [];
    for (let offset = start; offset + pattern.length <= end; offset++) {
        if (pattern.every((byte, index) => byte === undefined || bytes[offset + index] === byte)) {
            matches.push(offset);
        }
    }

    if (matches.length !== 1) {
        throw new Error(`${matches.length} runs of bytes match the pattern ${pattern.join(', ')}`);
    }

    bytes.set(replacement, matches[0]);
}

/** Finds a metadata stream, like `#Strings`, in the stream headers after the metadata root's `BSJB` signature. */
export function findMetadataStream(bytes: Uint8Array, name: string): { start: number; end: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const root = Buffer.from(bytes).indexOf('BSJB');
    const versionLength = view.getUint32(root + 12, true);
    const count = view.getUint16(root + 18 + versionLength, true);

    let header = root + 20 + versionLength;
    for (let index = 0; index < count; index++) {
        const nameEnd = bytes.indexOf(0, header + 8);
        if (new TextDecoder().decode(bytes.subarray(header + 8, nameEnd)) === name) {
            const offset = view.getUint32(header, true);

            return { start: root + offset, end: root + offset + view.getUint32(header + 4, true) };
        }

        // pads each name with its terminating 0 to 4 bytes, like ECMA-335 II.24.2.2
        header = nameEnd + 4 - ((nameEnd - header - 8) % 4);
    }

    throw new Error(`the assembly doesn't have the metadata stream ${name}`);
}
