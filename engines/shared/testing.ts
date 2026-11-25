import type { Engine } from '#contract/engine';
import { restoreWorker, useInThreadWorker } from '#contract/in-thread-worker';
import { connectEngine, type ConnectOptions } from '#contract/queue';
import type { EngineHandlers } from '#contract/serve';
import { afterEach, beforeEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export { buildStamped, type StampedBuild } from './stamp';

/**
 * Serves an engine's handlers in an in-thread worker during each test of a file and returns the function that connects
 * a test.
 */
export function useEngine(create: () => EngineHandlers, options: ConnectOptions, readMemoryBytes?: () => number): () => Engine {
    beforeEach(() => useInThreadWorker(create, readMemoryBytes));
    afterEach(restoreWorker);

    return () => connectEngine('engine.js', options);
}

/** Finds a tool by each of `names` in turn, in the folder of the environment variable, else on the PATH. */
export function findTool(names: string[], envName?: string): string | undefined {
    const folder = envName === undefined ? undefined : process.env[envName];
    const inFolder = folder ? names.map(name => join(folder, name)).find(path => existsSync(path)) : undefined;

    return inFolder ?? names.map(name => Bun.which(name)).find(path => path !== null) ?? undefined;
}

/** Finds the tool like `findTool`, or throws a text with what to install and why the tests need it. */
export function requireTool(names: string[], what: string, why: string, envName?: string): string {
    const found = findTool(names, envName);
    if (!found) {
        throw new Error(`Install ${what} because the tests ${why}.`);
    }

    return found;
}
