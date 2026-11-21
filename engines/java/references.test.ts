import { expect, setDefaultTimeout, test } from 'bun:test';
import { findRow, missingView } from '../../contract/checking';
import { formatTarget } from '../../contract/document';
import type { Engine } from '../../contract/engine';
import { EngineError } from '../../contract/reply';
import { readRows } from '../../contract/rows';
import { fixture } from './fixture';
import { useJavaEngine } from './testing';

const connect = useJavaEngine();
setDefaultTimeout(60000);

// opens the file and returns the function that finds the target of the row with a path, like `drawing.Main`
async function openFile(engine: Engine, file: File): Promise<(path: string) => string> {
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));

    return path => formatTarget({ fileId, key: findRow(rows, path, file.name).key });
}

async function findUsers(engine: Engine, target: string): Promise<string[]> {
    return (await engine.findReferences(target, 'java')).map(reference => reference.user).sort();
}

test('java engine finds the users of a member that code uses through a subclass', async () => {
    const engine = connect();
    const drawingOf = await openFile(engine, fixture.file);
    const shapesOf = await openFile(engine, fixture.linked.file);
    const users = [drawingOf('drawing.Box'), shapesOf('shapes.Base')].sort();

    expect(await findUsers(engine, shapesOf('shapes.Base.sides'))).toEqual(users);
    expect(await findUsers(engine, '|shapes/Base#sides#I')).toEqual(users);
});

test("java engine finds the users of a record's component through the component's accessor", async () => {
    const engine = connect();
    const targetOf = await openFile(engine, fixture.file);

    expect(await findUsers(engine, targetOf('drawing.Circle.radius'))).toEqual([targetOf('drawing.Circle'), targetOf('drawing.Main')].sort());
});

test('java engine finds the users of a class by its name, with each user once and without places', async () => {
    const engine = connect();
    const targetOf = await openFile(engine, fixture.file);
    const references = await engine.findReferences(targetOf('drawing.Circle'), 'java');

    expect(references.map(reference => reference.user).sort()).toEqual([targetOf('drawing.Circle'), targetOf('drawing.Main')].sort());
    expect(references.every(reference => reference.ranges === null)).toBe(true);
});

test("java engine finds the users of an annotation, its element and a class in a generic type's arguments", async () => {
    const engine = connect();
    const targetOf = await openFile(engine, fixture.file);

    expect(await findUsers(engine, targetOf('drawing.Marker'))).toEqual([targetOf('drawing.Box'), targetOf('drawing.Marker')].sort());
    expect(await findUsers(engine, targetOf('drawing.Marker.value'))).toEqual([targetOf('drawing.Box')]);
    const levelUsers = [targetOf('drawing.Box'), targetOf('drawing.Level'), targetOf('drawing.Named')];

    expect(await findUsers(engine, targetOf('drawing.Level'))).toEqual(levelUsers.sort());
});

test('java engine finds no user of an unused member, a package and a local', async () => {
    const engine = connect();
    const targetOf = await openFile(engine, fixture.file);
    const targets = [targetOf('drawing.Main.Entry.key'), targetOf('drawing'), 'L:0'];

    expect(await Promise.all(targets.map(target => engine.findReferences(target, 'java')))).toEqual([[], [], []]);
});

test("java engine refuses to find users in a view that it doesn't have", async () => {
    const engine = connect();
    const targetOf = await openFile(engine, fixture.file);

    await expect(engine.findReferences(targetOf('drawing.Main'), missingView)).rejects.toBeInstanceOf(EngineError);
});
