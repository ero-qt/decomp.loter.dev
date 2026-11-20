import { afterEach, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Engine } from '../../contract/engine';
import { restoreWorker, useInThreadWorker } from '../../contract/in-thread-worker';
import { connectEngine } from '../../contract/queue';
import { buildModule, moduleFolder } from './build/link';
import { mountInMemory } from './files';
import { buildFixture } from './fixture/build';
import { createNativeHandlers } from './handlers';
import { loadModule, type NativeModule } from './module';

let fixtureBuild: Promise<string> | undefined;

/** Reads a file of the fixture, like `shapes-x64.so`, and builds the fixture first when its sources changed. */
export async function readFixture(name: string): Promise<File> {
    fixtureBuild ??= buildFixture();
    const folder = await fixtureBuild;

    return new File([await Bun.file(join(folder, name)).bytes()], name);
}

/**
 * Serves the native engine in an in-thread worker during each test of a file and returns the function that connects a
 * test.
 */
export function useNativeEngine(): () => Engine {
    beforeEach(() => useInThreadWorker(() => createNativeHandlers(loadTestModule, mountInMemory), () => testModule?.readMemoryBytes() ?? 0));
    afterEach(restoreWorker);

    return () => connectEngine('native.js', { timeLimitMs: 120000, cancelLimitMs: 30000 });
}

let moduleLoad: Promise<NativeModule> | undefined;
let testModule: NativeModule | undefined;

async function buildAndLoad(): Promise<NativeModule> {
    await buildModule();
    const wasmBinary = await Bun.file(join(moduleFolder, 'rizin.wasm')).arrayBuffer();
    testModule = await loadModule(pathToFileURL(join(moduleFolder, 'rizin.mjs')).href, wasmBinary);

    return testModule;
}

/** Builds the module when its stamp is stale and loads it with its wasm from disk, once in a process. */
export function loadTestModule(): Promise<NativeModule> {
    moduleLoad ??= buildAndLoad();

    return moduleLoad;
}
