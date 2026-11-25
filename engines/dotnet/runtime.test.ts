import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testLoadFailure } from '#contract/conformance-testing';
import { useInThreadWorker } from '#contract/in-thread-worker';
import { frameworkFolder, publishEngine } from './build';
import { fixture } from './fixture';
import { createDotnetHandlers } from './handlers';
import { type DotnetRuntime, loadRuntime } from './runtime';
import { connectDotnet, loadTestRuntime, useDotnetEngine } from './testing';

await publishEngine();

const dotnetUrl = pathToFileURL(`${frameworkFolder}/dotnet.js`).href;

useDotnetEngine();

// serves the engine with a loader that fails like a lost connection as often as `failures` and then loads the runtime
function connectWithFailures(failures: number) {
    let failed = 0;
    async function loadFailing(): Promise<DotnetRuntime> {
        if (failed < failures) {
            failed++;
            throw new Error('Failed to fetch dynamically imported module.');
        }

        return loadTestRuntime();
    }

    useInThreadWorker(() => createDotnetHandlers(loadFailing));

    return connectDotnet();
}

testLoadFailure('dotnet engine', connectWithFailures, fixture, 120000);

test('dotnet runtime starts under Bun and calls an export', async () => {
    const runtime = await loadRuntime(dotnetUrl);

    runtime.exports.Reset();

    expect(runtime.readMemoryBytes()).toBeGreaterThan(0);
    expect(await loadRuntime(dotnetUrl)).toBe(runtime);
});

test('loadRuntime loads the runtime again after its load failed', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'runtime-')), 'dotnet.js');
    const url = pathToFileURL(path).href;
    await expect(loadRuntime(url)).rejects.toThrow();

    // writes a module like dotnet.js whose runtime has an empty set of exports and 1 byte of memory
    writeFileSync(path, `export const dotnet = { create: async () => ({
        getAssemblyExports: async () => ({ Decomp: { Dotnet: { Exports: {} } } }),
        getConfig: () => ({ mainAssemblyName: 'Decomp.Dotnet' }),
        Module: { HEAPU8: new Uint8Array(1) },
    }) };`);

    expect((await loadRuntime(url)).readMemoryBytes()).toBe(1);
});

test("publish doesn't write compressed copies or files beside the sources", () => {
    const files = readdirSync(frameworkFolder);

    expect(files).toContain('dotnet.js');
    expect(files.filter(name => /\.(br|gz)$/.test(name))).toEqual([]);
    expect(['bin', 'obj', 'src/bin', 'src/obj'].filter(folder => existsSync(new URL(folder, import.meta.url)))).toEqual([]);
});

test("publishEngine doesn't publish again while the stamp matches the sources and the SDK", async () => {
    const spawn = spyOn(Bun, 'spawnSync');

    await publishEngine();

    expect(spawn.mock.calls.filter(([command]) => (command as string[]).includes('publish'))).toEqual([]);
    spawn.mockRestore();
});

test("loadTestRuntime doesn't spawn a dotnet process after its first call in a process", async () => {
    await loadTestRuntime();
    const spawn = spyOn(Bun, 'spawnSync');

    await loadTestRuntime();

    expect(spawn.mock.calls).toEqual([]);
    spawn.mockRestore();
});
