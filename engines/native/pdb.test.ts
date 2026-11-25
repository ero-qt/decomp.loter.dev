import type { Engine } from '#contract/engine';
import { readRows, type Row } from '#contract/rows';
import { accessibilityOf, modifiersOf } from '#contract/symbols';
import { expect, test } from 'bun:test';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

async function openDll(name = 'shapes.dll'): Promise<{ engine: Engine; fileId: number }> {
    const engine = connect();
    const dll = await readFixture(name);

    return { engine, fileId: await engine.open(dll.name, dll) };
}

// writes each row as its path, like `geometry::Rect::area`, its kind and its flags
async function describeRows(engine: Engine, fileId: number): Promise<string[]> {
    const rows = readRows(await engine.list(fileId));
    const paths: string[] = [];
    for (const { name, parent } of rows) {
        paths.push(parent < 0 ? name : `${paths[parent]}::${name}`);
    }

    return rows.map(({ kind, flags }: Row, index) => [paths[index], kind, accessibilityOf(flags), ...modifiersOf(flags)].filter(Boolean).join(' '));
}

test('shapes.dll lists shapes.pdb as a missing companion until provide gets it', async () => {
    const { engine, fileId } = await openDll();
    const pdb = await readFixture('shapes.pdb');

    expect((await engine.list(fileId)).missingFiles).toEqual([{ name: 'shapes.pdb', reason: 'not loaded', isCompanion: true }]);

    await engine.provide(fileId, 'shapes.pdb', pdb);
    expect((await engine.list(fileId)).missingFiles).toEqual([]);
}, 120000);

test('provide refuses a pdb of another file', async () => {
    const { engine, fileId } = await openDll();
    const other = await readFixture('shapes-x86.pdb');

    await expect(engine.provide(fileId, 'shapes.pdb', other)).rejects.toThrow("shapes.pdb doesn't match shapes.dll.");
    await expect(engine.provide(fileId, 'other.pdb', other)).rejects.toThrow("shapes.dll doesn't need other.pdb.");
    expect((await engine.list(fileId)).missingFiles.map(missingFile => missingFile.name)).toEqual(['shapes.pdb']);
}, 120000);

test('geometry and Rect show after the pdb', async () => {
    const { engine, fileId } = await openDll();
    const before = await describeRows(engine, fileId);

    await engine.provide(fileId, 'shapes.pdb', await readFixture('shapes.pdb'));
    const after = await describeRows(engine, fileId);

    expect(before.filter(row => /^classify |::count /.test(row))).toEqual([]);
    expect(after).toContain('geometry namespace');
    expect(after).toContain('geometry::Rect class document');
    expect(after).toContain('geometry::Rect::count field public static');
    expect(after).toContain('classify method document static');
}, 120000);

test('msvc names give accessibility and static', async () => {
    const { engine, fileId } = await openDll();
    const rows = await describeRows(engine, fileId);

    expect(rows).toContain('geometry::Rect class document');
    expect(rows).toContain('geometry::Rect::area method public');
    expect(rows).toContain('geometry::Shape::sides method public virtual');

    const extras = await openDll('extras.dll');
    expect(await describeRows(extras.engine, extras.fileId)).toContain('extras::Counter::next method public static');
}, 120000);

test('a pdb file named in capitals in the debug directory is missing under that name', async () => {
    const { engine, fileId } = await openDll('extras.dll');

    expect((await engine.list(fileId)).missingFiles).toEqual([{ name: 'EXTRAS.PDB', reason: 'not loaded', isCompanion: true }]);
}, 120000);

test('each overload takes its own parameters from the pdb', async () => {
    const { engine, fileId } = await openDll('extras.dll');
    await engine.provide(fileId, 'EXTRAS.PDB', await readFixture('extras.pdb'));
    const overloads = readRows(await engine.list(fileId)).filter(row => row.name === 'scale');
    const signatures = await Promise.all(overloads.map(async row => (await engine.read(fileId, row.key, 'c')).text.split('\n')[0]));

    expect(signatures.map(signature => signature.slice(signature.indexOf('(')))).toEqual(['(int32_t value)', '(int32_t value, int32_t factor)']);
}, 120000);
