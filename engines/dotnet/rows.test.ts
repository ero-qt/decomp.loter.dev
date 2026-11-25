import { expect, test } from 'bun:test';
import { readRows, type Row } from '#contract/rows';
import { accessibilityOf, modifiersOf } from '#contract/symbols';
import { compileAssembly, loadTestRuntime, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

interface Listed {
    rows: Row[];
    paths: string[];
}

// lists the rows of a fixture's assembly with the path of each row, like `Drawing.Painter.Paint(Shape)`
async function listFixture(name: string): Promise<Listed> {
    const engine = connect();
    const file = await readFixture(name);
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));
    await engine.close(fileId);

    const paths: string[] = [];
    for (const { name: rowName, parent } of rows) {
        paths.push(parent < 0 ? rowName : `${paths[parent]}.${rowName}`);
    }

    return { rows, paths };
}

function findRow({ rows, paths }: Listed, path: string): Row {
    const row = rows[paths.indexOf(path)];
    if (!row) {
        throw new Error(`no row ${path} in ${paths.join(', ')}`);
    }

    return row;
}

function describeFlags({ flags }: Row): string {
    return [accessibilityOf(flags), ...modifiersOf(flags)].filter(word => word !== '').join(' ');
}

test("dotnet engine lists Drawing's namespace, its types with the document modifier and their members that C# shows", async () => {
    const { rows, paths } = await listFixture('Drawing.dll');
    const shown = [...rows.keys()].filter(index => rows[index].hiddenViews === 0);

    expect(shown.map(index => `${rows[index].kind} ${paths[index]}`)).toEqual([
        'section References',
        'reference References.System.Runtime',
        'reference References.Shapes',
        'reference References.System.Threading',
        'reference References.System.Console',
        'section Resources',
        'resource Resources.notes.txt',
        'resource Resources.palette.txt',
        'namespace Drawing',
        'class Drawing.Canvas',
        'field Drawing.Canvas.created',
        'field Drawing.Canvas.shapes',
        'constructor Drawing.Canvas.Canvas()',
        'constructor Drawing.Canvas.Canvas(int)',
        'property Drawing.Canvas.Created',
        'property Drawing.Canvas.Size',
        'indexer Drawing.Canvas.this[int]',
        'interface Drawing.ILayer',
        'property Drawing.ILayer.Name',
        'class Drawing.Painter',
        'method Drawing.Painter.Paint(Shape)',
        'method Drawing.Painter.Pick<T>(T, T)',
        'method Drawing.Painter.Scale(int)',
        'method Drawing.Painter.Sum(int[])',
        'method Drawing.Painter.Steps(int)',
        'method Drawing.Painter.WaitAsync()',
        'property Drawing.Painter.Count',
        'event Drawing.Painter.Painted',
        'class Drawing.Painter.Brush',
        'property Drawing.Painter.Brush.Color',
        'class Drawing.Sketch',
        'field Drawing.Sketch.names',
        'property Drawing.Sketch.Name',
        'property Drawing.Sketch.Origin',
        'enum Drawing.Tool',
        'enum_member Drawing.Tool.Pen',
        'enum_member Drawing.Tool.Brush',
        'enum_member Drawing.Tool.Eraser',
    ]);
    const documentRows = rows.filter(row => modifiersOf(row.flags).includes('document'));

    expect(documentRows.map(row => row.name)).toEqual(['Canvas', 'ILayer', 'Painter', 'Sketch', 'Tool']);
});

test('dotnet engine lists each referenced assembly with its version and each resource with its size and visibility', async () => {
    const drawing = await listFixture('Drawing.dll');
    const shapes = await listFixture('Shapes.dll');
    const paletteBytes = Bun.file(new URL('fixture/src/Drawing/palette.txt', import.meta.url)).size;
    const paths = [
        'References',
        'References.Shapes',
        'References.System.Runtime',
        'Resources',
        'Resources.notes.txt',
        'Resources.palette.txt',
    ];

    expect(paths.map(path => findRow(drawing, path)).map(row => `${describeFlags(row)} ${row.detail}`.trim())).toEqual([
        '',
        '0.0.0.0',
        '11.0.0.0',
        '',
        `private ${Bun.file(new URL('fixture/src/Drawing/notes.txt', import.meta.url)).size} bytes`,
        `public ${paletteBytes} bytes`,
    ]);
    expect(shapes.paths.filter(path => !path.includes('.')).slice(0, 2)).toEqual(['References', 'Shapes']);
});

test("dotnet engine keys a section by its metadata table and a reference or a resource by its token", async () => {
    const drawing = await listFixture('Drawing.dll');
    const keys = ['References', 'References.Shapes', 'Resources', 'Resources.notes.txt'].map(path => findRow(drawing, path).key);

    expect(keys.map(key => key.toString(16))).toEqual(['23000000', expect.stringMatching(/^2300000[1-9]$/), '28000000', '28000001']);
});

test('dotnet engine flags rows with their accessibility and modifiers', async () => {
    const drawing = await listFixture('Drawing.dll');
    const shapes = await listFixture('Shapes.dll');
    const flagged = [
        'Canvas',
        'Canvas.created',
        'Canvas.shapes',
        'Canvas.Canvas()',
        'Canvas.Created',
        'Painter.Brush',
        'Sketch.names',
    ];
    const shapesFlagged = [
        'Shape',
        'Shape.Area()',
        'Circle',
        'Circle.Area()',
        'Point',
        'Point.Dimensions',
        'Point.operator +(Point, Point)',
        'ShapeChanged',
    ];

    expect(flagged.map(path => describeFlags(findRow(drawing, `Drawing.${path}`)))).toEqual([
        'public document',
        'private static',
        'private readonly',
        'static',
        'public static',
        'public',
        'private static readonly',
    ]);
    expect(shapesFlagged.map(path => describeFlags(findRow(shapes, `Shapes.${path}`)))).toEqual([
        'public document abstract',
        'public abstract',
        'public document sealed',
        'public override',
        'public document',
        'public const',
        'public static',
        'public document',
    ]);
});

test('dotnet engine lists the kind of each type and member and the value of an enum member and a const', async () => {
    const shapes = await listFixture('Shapes.dll');
    const paths = [
        'Point',
        'Point.operator +(Point, Point)',
        'Point.implicit operator Point(int)',
        'Size',
        'ShapeChanged',
        'IMeasurable',
        'Color.Blue',
        'Point.Dimensions',
    ];

    expect(paths.map(path => findRow(shapes, `Shapes.${path}`)).map(row => `${row.kind} ${row.detail}`.trim())).toEqual([
        'struct',
        'operator',
        'operator',
        'record',
        'delegate',
        'interface',
        'enum_member 4',
        'field 2',
    ]);
});

test("dotnet engine hides the rows that C# doesn't declare in the view csharp", async () => {
    const shapes = await listFixture('Shapes.dll');
    const children = (path: string) => {
        return shapes.rows.filter(row => row.parent === shapes.paths.indexOf(path) && row.hiddenViews === 0).map(row => row.name);
    };

    expect(children('Shapes.Shape')).toEqual(['Area()', 'Label']);
    expect(children('Shapes.Size')).toEqual(['Size(int, int)', 'Width', 'Height']);
    expect(children('Shapes.ShapeChanged')).toEqual([]);
    expect(children('Shapes.Color')).toEqual(['Red', 'Green', 'Blue']);
});

test('dotnet engine lists backing fields, accessors and compiler-made types as rows that only IL declares', async () => {
    const drawing = await listFixture('Drawing.dll');
    const hidden = (path: string) => findRow(drawing, path).hiddenViews;
    const stateMachine = drawing.paths.indexOf('Drawing.Painter.<Steps>d__11');

    const paths = ['Drawing.Painter.<Count>k__BackingField', 'Drawing.Painter.Count.get_Count', 'Drawing.Painter.<Steps>d__11'];

    expect(paths.map(hidden)).toEqual([1, 1, 1]);
    expect(drawing.rows.filter(row => row.parent === stateMachine).every(row => row.hiddenViews === 1)).toBe(true);
    expect(drawing.rows.some(row => row.parent === stateMachine)).toBe(true);
});

test('dotnet engine hides the empty default constructor of a debug build in the view csharp', async () => {
    const engine = connect();
    const file = await compileAssembly('DebugDefault', 'public class Plain { public int Value = 1; }', [], { isDebug: true });
    const rows = readRows(await engine.list(await engine.open(file.name, file)));

    expect(rows.find(row => row.name === 'Plain()')?.hiddenViews).toBe(1);
});

test('dotnet engine lists <Module> as a document row when it has members', async () => {
    const engine = connect();
    const starter = 'class Starter { [System.Runtime.CompilerServices.ModuleInitializer] internal static void Run() { } }';
    const file = await compileAssembly('ModuleInit', starter);
    const rows = readRows(await engine.list(await engine.open(file.name, file)));
    const moduleRow = rows.find(row => row.name === '<Module>');

    expect(moduleRow && [describeFlags(moduleRow), moduleRow.hiddenViews]).toEqual(['internal document', 0]);
    expect(rows.filter(row => row.parent === rows.indexOf(moduleRow!)).map(row => row.name)).toEqual(['<Module>()']);
    expect((await listFixture('Drawing.dll')).paths).not.toContain('<Module>');
});

test('dotnet engine gives each row of a file its own key', async () => {
    for (const name of ['Drawing.dll', 'Shapes.dll']) {
        const keys = (await listFixture(name)).rows.map(row => row.key);

        expect(new Set(keys).size).toBe(keys.length);
    }
});
