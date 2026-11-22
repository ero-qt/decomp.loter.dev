import type { Engine } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { readRows } from '#contract/rows';
import { expect, test } from 'bun:test';
import { peFile } from '../dotnet/testing';
import { loadTestRuntime, readFixture, readOlderLayout, readOtherGame, useIl2CppEngine } from './testing';

const connect = useIl2CppEngine();
await loadTestRuntime();

async function openMetadata(engine: Engine): Promise<number> {
    const metadata = await readFixture('global-metadata.dat');

    return engine.open(metadata.name, metadata);
}

// maps each row's path below its parents, like `Shapes/Circle/Area()`, to the row's detail
async function listDetails(engine: Engine, fileId: number): Promise<Map<string, string>> {
    const rows = readRows(await engine.list(fileId));
    const paths: string[] = [];
    for (const { name, parent } of rows) {
        paths.push(parent < 0 || rows[parent].kind === 'section' ? name : `${paths[parent]}/${name}`);
    }

    return new Map(rows.map((row, index) => [paths[index], row.detail]));
}

test("il2cpp engine takes the game's binary for the missing file and lists the methods' addresses and types", async () => {
    const engine = connect();
    const fileId = await openMetadata(engine);

    await engine.provide(fileId, 'GameAssembly.dll', await readFixture('GameAssembly.dll'));
    const listing = await engine.list(fileId);
    const details = await listDetails(engine, fileId);

    expect(listing.missingFiles).toEqual([]);
    expect(listing.note).toBe('metadata 31.1, guessed among the layouts of version 31');
    expect(details.get('Shapes/Circle/Area()')).toMatch(/^0x[0-9a-f]+$/);
    expect(details.get('Shapes/Point/Length()')).toMatch(/^0x[0-9a-f]+$/);
    expect(details.get('Shapes/Circle/Area()')).not.toBe(details.get('Shapes/Point/Length()'));
    expect(details.get('Shapes/Shape/Area()')).toBe('');
    expect([...details.keys()].filter(path => path.startsWith('Shapes/Circle/') && path.includes('('))).toEqual([
        'Shapes/Circle/Circle(float)',
        'Shapes/Circle/Area()',
        'Shapes/Circle/Draw()',
        'Shapes/Circle/Unit()',
        'Shapes/Circle/Scale(float[])',
        'Shapes/Circle/Radius/get_Radius()',
        'Shapes/Circle/Radius/set_Radius(float)',
        'Shapes/Circle/Builder/Build()',
    ]);
});

test('il2cpp engine takes an android build of the binary under the missing file of the windows build', async () => {
    const engine = connect();
    const fileId = await openMetadata(engine);

    expect((await engine.list(fileId)).missingFiles).toEqual([
        { name: 'GameAssembly.dll', otherNames: ['libil2cpp.so'], reason: 'not loaded, or libil2cpp.so on Android and Linux', isCompanion: true },
    ]);

    await engine.provide(fileId, 'GameAssembly.dll', await readFixture('libil2cpp.so'));

    expect((await engine.list(fileId)).missingFiles).toEqual([]);
});

test("il2cpp engine refuses another build's binary and a binary without il2cpp tables and keeps the missing file", async () => {
    const engine = connect();
    const fileId = await openMetadata(engine);
    const other = await readOtherGame('GameAssembly.dll');
    const native = new File([peFile({ is64Bit: true, hasCliHeader: false })], 'GameAssembly.dll');

    await expect(engine.provide(fileId, 'GameAssembly.dll', other)).rejects.toThrow(
        new EngineError("GameAssembly.dll doesn't match global-metadata.dat."),
    );
    await expect(engine.provide(fileId, 'GameAssembly.dll', native)).rejects.toThrow(
        new EngineError("The engine can't find the IL2CPP tables in GameAssembly.dll. The file may be packed or protected."),
    );
    expect((await engine.list(fileId)).missingFiles.map(missingFile => missingFile.name)).toEqual(['GameAssembly.dll']);
});

test("il2cpp engine reads a binary in an older layout of the version after the newest layout doesn't fit and marks it as guessed", async () => {
    const engine = connect();
    const metadata = await readOlderLayout('global-metadata.dat');
    const fileId = await engine.open(metadata.name, metadata);

    await engine.provide(fileId, 'GameAssembly.dll', await readOlderLayout('GameAssembly.dll'));

    expect((await engine.list(fileId)).note).toBe('metadata 29, guessed among the layouts of version 29');
    expect((await listDetails(engine, fileId)).get('Shapes/Circle/Area()')).toMatch(/^0x[0-9a-f]+$/);
});
