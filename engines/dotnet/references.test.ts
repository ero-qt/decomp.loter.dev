import { findRow } from '#contract/checking';
import { formatTarget } from '#contract/document';
import type { Engine } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { readRows } from '#contract/rows';
import { expect, test } from 'bun:test';
import { compileAssembly, loadTestRuntime, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

type TargetOf = (path: string) => string;

async function openAssembly(engine: Engine, file: File): Promise<TargetOf> {
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));

    return path => formatTarget({ fileId, key: findRow(rows, path, file.name).key });
}

async function findUsers(engine: Engine, target: string): Promise<string[]> {
    const references = await engine.findReferences(target, 'csharp');
    expect(references.every(reference => reference.ranges === null)).toBe(true);

    return references.map(reference => reference.user);
}

test('users of Shape.Area include Painter.Paint in Drawing.dll', async () => {
    const engine = connect();
    const shapes = await openAssembly(engine, await readFixture('Shapes.dll'));
    const drawing = await openAssembly(engine, await readFixture('Drawing.dll'));

    expect(await findUsers(engine, shapes('Shapes.Shape.Area()'))).toContain(drawing('Drawing.Painter.Paint(Shape)'));
});

test("users of Shape.Area's outside target include Painter.Paint while Shapes.dll isn't open", async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, await readFixture('Drawing.dll'));

    expect(await findUsers(engine, '|Shapes|M:Shapes.Shape.Area')).toEqual([drawing('Drawing.Painter.Paint(Shape)')]);
});

test("users of a property are the members that call its accessors, with an async method's state machine as the method", async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, await readFixture('Drawing.dll'));

    expect(await findUsers(engine, drawing('Drawing.Painter.Count'))).toEqual(
        ['Paint(Shape)', 'Pick<T>(T, T)', 'WaitAsync()'].map(member => drawing(`Drawing.Painter.${member}`)),
    );
});

test('a use inside a lambda counts for the method that has the lambda', async () => {
    const engine = connect();
    const lambda = await openAssembly(
        engine,
        await compileAssembly(
            'Lambda',
            'public class Use { public static int Twice(int value) => value * 2; public System.Func<int, int> Make() => value => Twice(value); }',
        ),
    );

    expect(await findUsers(engine, lambda('Use.Twice(int)'))).toEqual([lambda('Use.Make()')]);
});

test("users of a type include the members that use its members and the members whose signatures name it", async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, await readFixture('Drawing.dll'));
    const users = await findUsers(engine, '|Shapes|T:Shapes.Shape');

    const typeUsers = ['Canvas.shapes', 'Canvas.Canvas(int)', 'Canvas.this[int]', 'Painter.Paint(Shape)'];

    expect(users).toEqual(expect.arrayContaining(typeUsers.map(path => drawing(`Drawing.${path}`))));
    expect(users).not.toContain(drawing('Drawing.Painter.Count'));
});

test('users of a type include the members whose code names it as a type argument, an array, a local or a caught type', async () => {
    const engine = connect();
    const text = `
        using System;
        using System.Collections.Generic;
        public class Shape { }
        public class ShapeException : Exception { }
        public class Uses
        {
            public static Shape Find() => null;
            public static T Make<T>() where T : new() => new T();
            public object MakeList() => new List<Shape>();
            public Type ReadArray() => typeof(Shape[]);
            public object CallGeneric() => Make<Shape>();
            public int KeepLocal() { var shape = Find(); Console.WriteLine(); return shape is null ? 0 : 1; }
            public void Catch() { try { Console.WriteLine(); } catch (ShapeException) { } }
            public int Other() => 1;
        }`;
    const uses = await openAssembly(engine, await compileAssembly('TypeUses', text, [], { isDebug: true }));
    const shapeUsers = await findUsers(engine, uses('Shape'));
    const members = ['Find()', 'MakeList()', 'ReadArray()', 'CallGeneric()', 'KeepLocal()'];

    expect(shapeUsers.toSorted()).toEqual(members.map(member => uses(`Uses.${member}`)).toSorted());
    expect(await findUsers(engine, uses('ShapeException'))).toEqual([uses('Uses.Catch()')]);
});

test("dotnet engine finds no users of a target without a row and refuses a view that it doesn't have", async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, await readFixture('Drawing.dll'));

    expect(await engine.findReferences('1:2ffffff', 'csharp')).toEqual([]);
    expect(await engine.findReferences('L:0', 'csharp')).toEqual([]);
    await expect(engine.findReferences(drawing('Drawing.Painter'), 'vb')).rejects.toBeInstanceOf(EngineError);
});
