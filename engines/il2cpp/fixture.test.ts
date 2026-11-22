import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildFixture } from './fixture/build';

const folder = buildFixture();

async function readStart(name: string, length: number): Promise<string> {
    return Buffer.from(await Bun.file(join(folder, name)).slice(0, length).bytes()).toString('hex');
}

test('fixture metadata starts with the magic and version 31', async () => {
    expect(await readStart('global-metadata.dat', 8)).toBe('af1bb1fa1f000000');
});

test('fixture build writes a pe and an elf binary beside the metadata', async () => {
    expect(await readStart('GameAssembly.dll', 2)).toBe('4d5a');
    expect(await readStart('libil2cpp.so', 4)).toBe('7f454c46');
});

test('fixture binaries export il2cpp_init like a unity build', async () => {
    for (const name of ['GameAssembly.dll', 'libil2cpp.so']) {
        expect(Buffer.from(await Bun.file(join(folder, name)).bytes()).includes('il2cpp_init\0')).toBe(true);
    }
});
