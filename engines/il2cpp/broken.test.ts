import { findRow } from '#contract/checking';
import { EngineError } from '#contract/reply';
import { readRows } from '#contract/rows';
import { expect, test } from 'bun:test';
import { readCyclicGame, readFixture, useIl2CppEngine } from './testing';

const connect = useIl2CppEngine();
const metadata = await readFixture('global-metadata.dat');

// the header's version and its 3rd section, the string section, in the version 31 layout of 8 bytes for each section
const versionOffset = 4;
const namesOffset = 8 + 2 * 8;

async function changeMetadata(change: (view: DataView, bytes: Uint8Array) => void): Promise<File> {
    const bytes = new Uint8Array(await metadata.bytes());
    change(new DataView(bytes.buffer), bytes);

    return new File([bytes], 'global-metadata.dat');
}

test('il2cpp engine refuses a metadata version that LibCpp2IL reads neither old nor new', async () => {
    const engine = connect();
    const newer = await changeMetadata(view => view.setInt32(versionOffset, 110, true));
    const older = await changeMetadata(view => view.setInt32(versionOffset, 22, true));

    const newerText = "global-metadata.dat has version 110, which the engine can't read.";
    const olderText = "global-metadata.dat has version 22, which the engine can't read.";

    await expect(engine.open(newer.name, newer)).rejects.toThrow(new EngineError(newerText));
    await expect(engine.open(older.name, older)).rejects.toThrow(new EngineError(olderText));
});

test('il2cpp engine refuses scrambled or cut metadata as encrypted or damaged and opens good metadata after that', async () => {
    const engine = connect();
    const damaged = new EngineError('global-metadata.dat is encrypted or damaged.');
    const scrambledVersion = await changeMetadata(view => view.setInt32(versionOffset, 0x5a3c9e17, true));
    const cut = new File([metadata.slice(0, 200)], 'global-metadata.dat');
    const pastEnd = await changeMetadata((view, bytes) => view.setInt32(namesOffset, bytes.length - 4, true));
    const scrambledNames = await changeMetadata((view, bytes) => {
        const start = view.getInt32(namesOffset, true);
        bytes.fill(0xff, start, start + view.getInt32(namesOffset + 4, true));
    });

    for (const file of [scrambledVersion, cut, pastEnd, scrambledNames]) {
        await expect(engine.open(file.name, file)).rejects.toThrow(damaged);
    }
    expect(await engine.open(metadata.name, metadata)).toBeGreaterThan(0);
});

test('il2cpp engine reads a game whose crafted metadata nests 2 types in each other', async () => {
    const engine = connect();
    const cyclic = await readCyclicGame('global-metadata.dat');
    const fileId = await engine.open(cyclic.name, cyclic);

    await engine.provide(fileId, 'GameAssembly.dll', await readCyclicGame('GameAssembly.dll'));
    const player = findRow(readRows(await engine.list(fileId)), 'Assembly-CSharp.dll.Player', cyclic.name);

    expect((await engine.read(fileId, player.key, 'csharp')).text).toContain('public A loop;');
}, 60000);
