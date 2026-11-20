import { expect, test } from 'bun:test';
import { findRow } from '../../contract/checking';
import { formatTarget } from '../../contract/document';
import type { Engine } from '../../contract/engine';
import { EngineError } from '../../contract/reply';
import { readRows, type Row } from '../../contract/rows';
import { loadTestRuntime, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

const area = '|Shapes|M:Shapes.Shape.Area';

interface OpenAssembly {
    fileId: number;
    rows: Row[];
    targetOf(path: string): string;
}

async function openAssembly(engine: Engine, name: string): Promise<OpenAssembly> {
    const file = await readFixture(name);
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));

    return { fileId, rows, targetOf: path => formatTarget({ fileId, key: findRow(rows, path, file.name).key }) };
}

test("the outside target of Area resolves to Shapes' row once Shapes.dll is open", async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, 'Drawing.dll');

    expect(await engine.resolve(area)).toBeNull();

    const shapes = await openAssembly(engine, 'Shapes.dll');
    expect(await engine.resolve(area)).toBe(shapes.targetOf('Shapes.Shape.Area()'));
    expect(await engine.resolve(drawing.targetOf('Drawing.Painter'))).toBe(drawing.targetOf('Drawing.Painter'));
    expect(await engine.resolve('|Shapes|M:Shapes.Shape.Missing')).toBeNull();
});

test('dotnet engine describes a row with its C# signature, its container, its token and its RVA', async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, 'Drawing.dll');

    expect(await engine.describe(drawing.targetOf('Drawing.Painter.Paint(Shape)'), 'csharp')).toEqual({
        text: 'public void Paint(Shape shape)',
        container: 'Drawing.Painter',
        facts: [
            ['token', '0x0600000C'],
            ['RVA', expect.stringMatching(/^0x[0-9A-F]{4,}$/)],
        ],
        missingFile: null,
    });
    expect(await engine.describe(drawing.targetOf('Drawing.Painter.Brush'), 'csharp')).toMatchObject({
        text: 'public class Brush',
        container: 'Drawing.Painter',
    });
    expect(await engine.describe(drawing.targetOf('Drawing.Painter'), 'csharp')).toMatchObject({
        container: 'Drawing',
        facts: [['token', '0x02000004']],
    });
    expect(await engine.describe(drawing.targetOf('Drawing'), 'csharp')).toEqual({
        text: 'namespace Drawing',
        container: null,
        facts: [],
        missingFile: null,
    });
});

test('dotnet engine describes a reference with its full name and version and a resource with its name, size and visibility', async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, 'Drawing.dll');
    const paletteBytes = Bun.file(new URL('fixture/src/Drawing/palette.txt', import.meta.url)).size;

    expect(await engine.describe(drawing.targetOf('References.Shapes'), 'csharp')).toEqual({
        text: 'Shapes, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null',
        container: null,
        facts: [
            ['token', expect.stringMatching(/^0x2300000[1-9]$/)],
            ['version', '0.0.0.0'],
        ],
        missingFile: 'Shapes.dll',
    });
    expect(await engine.describe(drawing.targetOf('Resources.palette.txt'), 'csharp')).toEqual({
        text: 'palette.txt',
        container: null,
        facts: [
            ['token', '0x28000002'],
            ['size', `${paletteBytes} bytes`],
            ['visibility', 'public'],
        ],
        missingFile: null,
    });
    expect(await engine.describe(drawing.targetOf('References'), 'csharp')).toEqual({
        text: 'References',
        container: null,
        facts: [],
        missingFile: null,
    });
});

test("dotnet engine doesn't write a document of a section, a reference or a resource and finds no users of them", async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, 'Drawing.dll');

    for (const path of ['References', 'References.Shapes', 'Resources', 'Resources.palette.txt']) {
        const { key } = findRow(drawing.rows, path, 'Drawing.dll');

        await expect(engine.read(drawing.fileId, key, 'csharp')).rejects.toBeInstanceOf(EngineError);
        expect(await engine.findReferences(drawing.targetOf(path), 'csharp')).toEqual([]);
    }
});

test("dotnet engine describes a symbol outside the open files with the missing file that has it until the file is open", async () => {
    const engine = connect();
    await openAssembly(engine, 'Drawing.dll');

    expect(await engine.describe(area, 'csharp')).toEqual({ text: 'Area', container: 'Shapes.Shape', facts: [], missingFile: 'Shapes.dll' });
    expect(await engine.describe('|Other|T:Other.Thing', 'csharp')).toEqual({ text: 'Thing', container: 'Other', facts: [], missingFile: null });

    await openAssembly(engine, 'Shapes.dll');
    expect(await engine.describe(area, 'csharp')).toMatchObject({
        text: 'public abstract double Area()',
        container: 'Shapes.Shape',
        missingFile: null,
    });
});

test("dotnet engine doesn't describe a local, a key without a row or a closed file's row and refuses a view that it doesn't have", async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, 'Drawing.dll');
    const painter = drawing.targetOf('Drawing.Painter');

    expect(await engine.describe('L:0', 'csharp')).toBeNull();
    expect(await engine.describe(formatTarget({ fileId: drawing.fileId, key: 0x02ffffff }), 'csharp')).toBeNull();
    await expect(engine.describe(painter, 'vb')).rejects.toBeInstanceOf(EngineError);

    await engine.close(drawing.fileId);
    expect(await engine.describe(painter, 'csharp')).toBeNull();
    expect(await engine.resolve(painter)).toBeNull();
});
