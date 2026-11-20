import { afterEach, beforeEach } from 'bun:test';
import { join } from 'node:path';
import type { Engine } from '../../contract/engine';
import { restoreWorker, useInThreadWorker } from '../../contract/in-thread-worker';
import { connectEngine } from '../../contract/queue';
import { buildFixture } from './fixture/build';
import { createNativeHandlers } from './handlers';

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
    beforeEach(() => useInThreadWorker(() => createNativeHandlers()));
    afterEach(restoreWorker);

    return () => connectEngine('native.js', { timeLimitMs: 120000, cancelLimitMs: 30000 });
}
