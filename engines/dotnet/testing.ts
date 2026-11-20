import { afterEach, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from '../../contract/engine';
import { restoreWorker, useInThreadWorker } from '../../contract/in-thread-worker';
import { connectEngine } from '../../contract/queue';
import { buildFixture } from './fixture/build';
import { createDotnetHandlers } from './handlers';

/** The folder that the tests build the fixture's assemblies into. */
export const fixtureFolder = fileURLToPath(new URL('../../artifacts/dotnet-fixture/', import.meta.url));

let fixtureBuild: Promise<void> | undefined;

/** Reads an assembly of the fixture, like `Drawing.dll`, and builds the fixture first when its stamp is stale. */
export async function readFixture(name: string): Promise<File> {
    fixtureBuild ??= buildFixture(fixtureFolder, Bun.which('dotnet') ?? undefined);
    await fixtureBuild;

    return new File([await Bun.file(join(fixtureFolder, name)).bytes()], name);
}

/**
 * Serves the .NET engine in an in-thread worker during each test of a file and returns the function that connects a
 * test.
 */
export function useDotnetEngine(): () => Engine {
    beforeEach(() => useInThreadWorker(createDotnetHandlers));
    afterEach(restoreWorker);

    return () => connectEngine('dotnet.js', { timeLimitMs: 120000, cancelLimitMs: 30000, hasLinkedFiles: true });
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
