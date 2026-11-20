import { expect, test } from 'bun:test';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCompileRules } from './build/ghidra';
import { buildModule, moduleFolder } from './build/link';
import { listConfigureInputs } from './build/rizin';
import { readToolVersions } from './build/stamp';
import { loadTestModule } from './testing';

const repoFolder = fileURLToPath(new URL('../../', import.meta.url));
// gives a host's first build up to an hour, because it compiles Rizin, Ghidra's decompiler and Emscripten's libraries
const buildTimeoutMs = 60 * 60 * 1000;

test('module loads in bun and reports rizin 0.9.1', async () => {
    const module = await loadTestModule();
    const session = module.newSession();

    expect(session).not.toBe(0);
    expect(module.runCommand(session, 'verq').trim()).toBe('0.9.1');
    module.freeSession(session);
}, buildTimeoutMs);

test('second build with the same inputs returns without a compile', async () => {
    await buildModule();
    const wasm = join(moduleFolder, 'rizin.wasm');
    const builtAt = statSync(wasm).mtimeMs;
    const start = performance.now();

    await buildModule();

    expect(statSync(wasm).mtimeMs).toBe(builtAt);
    expect(performance.now() - start).toBeLessThan(10000);
}, buildTimeoutMs);

test("rizin.mjs doesn't have the repo's path", async () => {
    await buildModule();

    expect(await Bun.file(join(moduleFolder, 'rizin.mjs')).text()).not.toContain(repoFolder);
}, buildTimeoutMs);

test("rizin.wasm doesn't have the repo's path", async () => {
    await buildModule();

    expect(Buffer.from(await Bun.file(join(moduleFolder, 'rizin.wasm')).bytes()).includes(repoFolder)).toBe(false);
}, buildTimeoutMs);

test("tool versions read before the build's folder exists", () => {
    const missing = fileURLToPath(new URL('../../artifacts/native-test/missing/', import.meta.url));
    rmSync(missing, { recursive: true, force: true });

    expect(readToolVersions(missing)).toContain('emcc');
});

test("rizin's configure stamp hashes the script that configures it", () => {
    expect(listConfigureInputs()).toContain(fileURLToPath(new URL('build/rizin.ts', import.meta.url)));
});

test("each compile of the decompiler's build writes a depfile, so a changed header compiles its sources again", () => {
    const rules = writeCompileRules('-Iinclude', '-DRIZIN').join('\n').split(/^rule /m).slice(1).map(rule => rule.trimEnd());

    expect(rules.map(rule => rule.slice(0, rule.indexOf('\n')))).toEqual(['cxx', 'cxxrz', 'cc']);
    for (const rule of rules) {
        expect(rule).toContain('-MD -MF $out.d');
        expect(rule).toEndWith('\n  depfile = $out.d\n  deps = gcc');
    }
});
