import { expect, spyOn, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { frameworkFolder, publishEngine } from './build';
import { loadRuntime } from './runtime';
import { loadTestRuntime } from './testing';

await publishEngine();

const dotnetUrl = pathToFileURL(`${frameworkFolder}/dotnet.js`).href;

test('dotnet runtime starts under Bun and calls an export', async () => {
    const runtime = await loadRuntime(dotnetUrl);

    runtime.exports.Reset();

    expect(runtime.readMemoryBytes()).toBeGreaterThan(0);
    expect(await loadRuntime(dotnetUrl)).toBe(runtime);
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
