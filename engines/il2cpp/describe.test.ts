import { findRow } from '#contract/checking';
import { formatTarget } from '#contract/document';
import type { Engine } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { readRows } from '#contract/rows';
import { expect, test } from 'bun:test';
import { loadTestRuntime, readFixture, useIl2CppEngine } from './testing';

const connect = useIl2CppEngine();
await loadTestRuntime();

async function openGame(engine: Engine) {
    const metadata = await readFixture('global-metadata.dat');
    const fileId = await engine.open(metadata.name, metadata);
    await engine.provide(fileId, 'GameAssembly.dll', await readFixture('GameAssembly.dll'));
    const rows = readRows(await engine.list(fileId));
    const rowOf = (path: string) => findRow(rows, `Assembly-CSharp.dll.${path}`, metadata.name);

    return { rowOf, targetOf: (path: string) => formatTarget({ fileId, key: rowOf(path).key }) };
}

test("il2cpp engine describes a method with its C# declaration, its type and its code's addresses, without the metadata's token", async () => {
    const engine = connect();
    const game = await openGame(engine);
    const rva = Number(game.rowOf('Shapes.Circle.Area()').detail);

    expect(await engine.describe(game.targetOf('Shapes.Circle.Area()'), 'csharp')).toEqual({
        text: 'public override float Area()',
        container: 'Shapes.Circle',
        facts: [
            ['RVA', `0x${rva.toString(16)}`],
            ['VA', `0x${(0x180000000 + rva).toString(16)}`],
            ['offset', `0x${(rva - 0xc00).toString(16)}`],
        ],
        missingFile: null,
    });
});

test("il2cpp engine describes types, fields and properties like the .NET engine, with a type's index and a field's offset", async () => {
    const engine = connect();
    const game = await openGame(engine);
    const describe = (path: string) => engine.describe(game.targetOf(path), 'csharp');

    expect(await describe('Shapes.Circle')).toEqual({
        text: 'public class Circle',
        container: 'Shapes',
        facts: [['TypeDefIndex', '22']],
        missingFile: null,
    });
    expect(await describe('Shapes.Circle.Builder')).toMatchObject({ text: 'public class Builder', container: 'Shapes.Circle' });
    expect(await describe('Player')).toMatchObject({ container: null });
    expect(await describe('Shapes.Circle.radius')).toMatchObject({
        text: 'private float radius',
        facts: [['offset', '0x18']],
    });
    expect(await describe('Shapes.Color.Green')).toMatchObject({ text: 'Color.Green = 1' });
    expect(await describe('Shapes.Circle.Radius')).toMatchObject({
        text: 'public float Radius',
        container: 'Shapes.Circle',
        facts: [
            ['get RVA', game.rowOf('Shapes.Circle.Radius.get_Radius()').detail],
            ['set RVA', game.rowOf('Shapes.Circle.Radius.set_Radius(float)').detail],
        ],
    });
    expect(await describe('Shapes.Shape.Area()')).toMatchObject({ text: 'public abstract float Area()', facts: [] });
});

test("il2cpp engine returns null for a target it doesn't have and refuses a view it doesn't write", async () => {
    const engine = connect();
    const game = await openGame(engine);

    expect(await engine.describe('|System.Object', 'csharp')).toBeNull();
    expect(await engine.describe(formatTarget({ fileId: 99, key: 0 }), 'csharp')).toBeNull();
    const refusal = new EngineError("The IL2CPP engine doesn't have the view il.");

    await expect(engine.describe(game.targetOf('Shapes.Circle'), 'il')).rejects.toThrow(refusal);
});

test('il2cpp engine resolves a row target to itself and a target outside the open files to null', async () => {
    const engine = connect();
    const game = await openGame(engine);

    expect(await engine.resolve(game.targetOf('Shapes.Circle.Area()'))).toBe(game.targetOf('Shapes.Circle.Area()'));
    expect(await engine.resolve('|System.Object')).toBeNull();
});

test("il2cpp engine refuses to find the references in a view that the manifest doesn't have", async () => {
    const engine = connect();
    const { targetOf } = await openGame(engine);

    await expect(engine.findReferences(targetOf('Shapes.Circle'), 'il')).rejects.toThrow(
        new EngineError("The IL2CPP engine doesn't have the view il."),
    );
});
