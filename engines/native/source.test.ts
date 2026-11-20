import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import copyIntoSite from './build';
import { listModuleInputs } from './build/link';

const engineFolder = fileURLToPath(new URL('.', import.meta.url));
const siteFolder = fileURLToPath(new URL('../../artifacts/native-test/site/', import.meta.url));
const prebuiltFolder = fileURLToPath(new URL('../../artifacts/native-test/prebuilt/', import.meta.url));
// gives a host's first build up to an hour, because the hook builds the module when its stamp is stale
const buildTimeoutMs = 60 * 60 * 1000;

test('site serves the versions, glue, build scripts and submodule commits of the native engine', async () => {
    rmSync(siteFolder, { recursive: true, force: true });

    await copyIntoSite(siteFolder);
    const sourceFolder = join(siteFolder, 'source');
    const inputs = listModuleInputs();

    expect(inputs.length).toBeGreaterThan(20);
    for (const path of inputs) {
        expect(readFileSync(join(sourceFolder, relative(engineFolder, path)))).toEqual(readFileSync(path));
    }
    const served = [
        'rizin.mjs',
        'rizin.wasm',
        'share/files.txt',
        'sleigh/files.txt',
        'source/COPYING',
        'source/COPYING.LESSER',
        'source/readme.md',
        'source/submodules.txt',
    ];
    for (const path of served) {
        expect(existsSync(join(siteFolder, path))).toBe(true);
    }
    expect(readFileSync(join(sourceFolder, 'readme.md'), 'utf8')).toContain('https://github.com/ero-qt/decomp.loter.dev');
    expect(readFileSync(join(sourceFolder, 'submodules.txt'), 'utf8')).toContain('engines/native/vendor/rizin https://github.com/ero-qt/rizin/tree/');
}, buildTimeoutMs);

test("the hook copies the module in NATIVE_MODULE's folder without a build, like a module that another job built", async () => {
    rmSync(siteFolder, { recursive: true, force: true });
    rmSync(prebuiltFolder, { recursive: true, force: true });
    const files = ['rizin.mjs', 'rizin.wasm', 'share/files.txt', 'sleigh/files.txt', 'COPYING', 'COPYING.LESSER', 'submodules.txt'];
    for (const file of files) {
        mkdirSync(dirname(join(prebuiltFolder, file)), { recursive: true });
        writeFileSync(join(prebuiltFolder, file), `prebuilt ${file}`);
    }

    process.env.NATIVE_MODULE = prebuiltFolder;
    try {
        await copyIntoSite(siteFolder);
    } finally {
        delete process.env.NATIVE_MODULE;
    }

    expect(readFileSync(join(siteFolder, 'rizin.wasm'), 'utf8')).toBe('prebuilt rizin.wasm');
    expect(readFileSync(join(siteFolder, 'sleigh', 'files.txt'), 'utf8')).toBe('prebuilt sleigh/files.txt');
    expect(readFileSync(join(siteFolder, 'source', 'COPYING.LESSER'), 'utf8')).toBe('prebuilt COPYING.LESSER');
}, buildTimeoutMs);
