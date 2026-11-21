import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLlvmTool } from './fixture/build';
import { readFixture } from './testing';

const testFolder = fileURLToPath(new URL('../../artifacts/native-test/llvm/', import.meta.url));

async function readStart(name: string, length: number): Promise<string> {
    const file = await readFixture(name);

    return Buffer.from(await file.slice(0, length).bytes()).toString('hex');
}

// makes a folder with empty files of the names, like the folder of a distribution's tools
function makeFolder(name: string, files: string[]): string {
    const folder = join(testFolder, name);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    for (const file of files) {
        writeFileSync(join(folder, file), '');
    }

    return folder;
}

test('fixture build writes an elf, a pe with its pdb and a fat mach-o', async () => {
    expect(await readStart('shapes-x64.so', 4)).toBe('7f454c46');
    expect(await readStart('shapes.dll', 2)).toBe('4d5a');
    expect(await readStart('shapes.pdb', 24)).toBe(Buffer.from('Microsoft C/C++ MSF 7.00').toString('hex'));
    expect(await readStart('shapes-fat.dylib', 8)).toBe('cafebabe00000002');
}, 120000);

test('llvm tools come from NATIVE_LLVM, else from the path under their own or newest versioned name, else from emscripten', () => {
    const llvm = makeFolder('llvm', ['clang']);
    const bin = makeFolder('bin', ['clang', 'lld-link', 'ld.lld-17', 'ld.lld-18', 'ld.lld-9']);
    const emscripten = makeFolder('emscripten', ['clang', 'lld-link', 'ld.lld', 'llvm-lipo']);

    expect(findLlvmTool('clang', { llvm, emscripten }, bin)).toBe(join(llvm, 'clang'));
    expect(findLlvmTool('lld-link', { llvm, emscripten }, bin)).toBe(join(bin, 'lld-link'));
    expect(findLlvmTool('ld.lld', { emscripten }, bin)).toBe(join(bin, 'ld.lld-18'));
    expect(findLlvmTool('llvm-lipo', { llvm, emscripten }, bin)).toBe(join(emscripten, 'llvm-lipo'));
    expect(() => findLlvmTool('llvm-dlltool', { llvm, emscripten }, bin)).toThrow(
        'Put llvm-dlltool on the PATH or in NATIVE_LLVM because the tests build the native fixture with it.',
    );
});
