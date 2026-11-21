import { expect, test } from 'bun:test';
import { formatTarget } from '../../contract/document';
import type { Engine } from '../../contract/engine';
import { readRows } from '../../contract/rows';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

// opens shapes-x64.so and returns the function that finds the target of the first row with a name
async function openShapes(engine: Engine): Promise<(name: string) => string> {
    const file = await readFixture('shapes-x64.so');
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));

    return name => formatTarget({ fileId, key: rows.find(row => row.name === name)!.key });
}

test("describe gives a function's signature, its class, address and size", async () => {
    const engine = connect();
    const targetOf = await openShapes(engine);

    expect(await engine.describe(targetOf('area'), 'c')).toEqual({
        text: 'long geometry::Rect::area(const struct Rect *this, int scale)',
        container: 'geometry::Rect',
        facts: [
            ['address', '0x1990'],
            ['size', '32'],
        ],
        missingFile: null,
    });
    expect(await engine.describe(targetOf('add'), 'c')).toMatchObject({ text: 'int add(int left, int right)', container: null });
    expect(await engine.describe(targetOf('Rect'), 'c')).toMatchObject({ text: 'class geometry::Rect', container: 'geometry' });
}, 120000);

test('describe returns null for a local and an unknown target', async () => {
    const engine = connect();
    const targetOf = await openShapes(engine);
    const fileId = targetOf('add').split(':')[0];

    expect(await engine.describe('L:0', 'c')).toBeNull();
    expect(await engine.describe(`${fileId}:7777`, 'c')).toBeNull();
    expect(await engine.describe('|elsewhere', 'c')).toBeNull();
    await expect(engine.describe(targetOf('add'), 'asm')).rejects.toThrow("The native engine doesn't have the view asm.");
}, 120000);

test('a row target resolves to itself', async () => {
    const engine = connect();
    const targetOf = await openShapes(engine);
    const fileId = targetOf('add').split(':')[0];

    expect(await engine.resolve(targetOf('add'))).toBe(targetOf('add'));
    expect(await engine.resolve(`${fileId}:7777`)).toBeNull();
    expect(await engine.resolve('|elsewhere')).toBeNull();
}, 120000);
