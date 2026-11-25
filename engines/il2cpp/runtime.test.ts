import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { frameworkFolder, publishEngine } from '../dotnet/build';
import { loadTestRuntime as loadDotnetTestRuntime } from '../dotnet/testing';
import { loadRuntime } from './runtime';
import { loadTestRuntime } from './testing';

await publishEngine();

test('il2cpp runtime starts under Bun and calls an export', async () => {
    const runtime = await loadRuntime(pathToFileURL(`${frameworkFolder}/dotnet.js`).href);

    runtime.exports.Reset();

    expect(runtime.readMemoryBytes()).toBeGreaterThan(0);
    expect(await loadTestRuntime()).toBe(runtime);
});

test("il2cpp engine runs in the .NET engine's runtime, whose publish has LibCpp2IL", async () => {
    const files = readdirSync(frameworkFolder);
    const dotnet = await loadDotnetTestRuntime();
    const il2cpp = await loadTestRuntime();

    expect(files.some(name => name.startsWith('LibCpp2IL.'))).toBe(true);
    expect(il2cpp.readMemoryBytes()).toBe(dotnet.readMemoryBytes());
    expect(['bin', 'obj', 'src', 'build.ts'].filter(path => existsSync(new URL(path, import.meta.url)))).toEqual([]);
});

