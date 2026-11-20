import { expect, test } from 'bun:test';
import { formatTarget } from '../../contract/document';
import type { Engine } from '../../contract/engine';
import { readRows } from '../../contract/rows';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

// opens a fixture's file and returns the function that finds the target of the first row with a name
async function openShapes(engine: Engine, name = 'shapes-x64.so'): Promise<(name: string) => string> {
    const file = await readFixture(name);
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));

    return name => formatTarget({ fileId, key: rows.find(row => row.name === name)!.key });
}

test("add's users are add_twice and add_swapped", async () => {
    const engine = connect();
    const targetOf = await openShapes(engine);

    expect(await engine.findReferences(targetOf('add'), 'c')).toEqual([
        { user: targetOf('add_twice'), ranges: null },
        { user: targetOf('add_swapped'), ranges: null },
    ]);
    expect(await engine.findReferences('|elsewhere', 'c')).toEqual([]);
}, 120000);

test('findReferences refuses an unknown view', async () => {
    const engine = connect();
    const targetOf = await openShapes(engine);

    await expect(engine.findReferences(targetOf('add'), 'asm')).rejects.toThrow("The native engine doesn't have the view asm.");
}, 120000);

test('users of a function in a file at a high image base', async () => {
    const engine = connect();
    const targetOf = await openShapes(engine, 'extras-high.so');

    expect(await engine.findReferences(targetOf('scale'), 'c')).toEqual([{ user: targetOf('scale_twice'), ranges: null }]);
}, 120000);
