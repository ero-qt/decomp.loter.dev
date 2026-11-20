import { expect, test } from 'bun:test';
import { readRows, type Row } from '../../contract/rows';
import { accessibilityOf, modifiersOf } from '../../contract/symbols';
import { fixture } from './fixture';
import { classFile, useJavaEngine, zipFile } from './testing';

const connect = useJavaEngine();

// lists the rows of a file with the path of each row, like `drawing.Main.classify`, and the file's note
async function listFile(file: File): Promise<{ rows: Row[]; paths: string[]; note: string }> {
    const engine = connect();
    const fileId = await engine.open(file.name, file);
    const listing = await engine.list(fileId);
    await engine.close(fileId);
    const rows = readRows(listing);
    const paths: string[] = [];
    for (const { name, parent } of rows) {
        paths.push(parent < 0 ? name : `${paths[parent]}.${name}`);
    }

    return { rows, paths, note: listing.note };
}

// finds the first row with the path below the package `drawing`
function findRow({ rows, paths }: { rows: Row[]; paths: string[] }, path: string): Row {
    return rows[paths.indexOf(path === '' ? 'drawing' : `drawing.${path}`)];
}

function describeFlags({ flags }: Row): string {
    return [accessibilityOf(flags), ...modifiersOf(flags)].join(' ');
}

test('java engine lists the package, then the classes by name with nested classes below their outer class', async () => {
    const { rows, paths } = await listFile(fixture.file);
    const classes = rows.filter(row => row.detail === '' && !['field', 'enum_member'].includes(row.kind));

    expect(classes.map(row => `${row.kind} ${paths[rows.indexOf(row)]}`)).toEqual([
        'namespace drawing',
        'class drawing.Box',
        'record drawing.Circle',
        'enum drawing.Color',
        'enum drawing.Level',
        'class drawing.Main',
        'class drawing.Main.Cursor',
        'class drawing.Main.Entry',
        'annotation drawing.Marker',
        'interface drawing.Named',
        'record drawing.Point',
    ]);
});

test('java engine lists members with their kinds and parameter types', async () => {
    const listed = await listFile(fixture.file);
    const members = ['Main.classify', 'Main.sum', 'Main.Main', 'Main.Cursor.Cursor', 'Color.Color', 'Color.RED', 'Box.Box', 'Box.get', 'Main.names'];

    expect(members.map(path => findRow(listed, path)).map(row => `${row.kind} ${row.name}${row.detail}`)).toEqual([
        'method classify(Shape)',
        'method sum(int...)',
        'constructor Main()',
        'constructor Cursor()',
        'constructor Color(String)',
        'enum_member RED',
        'constructor Box(T)',
        'method get()',
        'field names',
    ]);
});

test('java engine flags rows with their accessibility and modifiers', async () => {
    const listed = await listFile(fixture.file);
    const flagged = [
        'Main',
        'Main.Entry',
        'Main.hits',
        'Main.done',
        'Main.count',
        'Main.GREETING',
        'Named',
        'Named.label',
        'Marker.value',
        'Color.Color',
    ];

    expect(flagged.map(path => describeFlags(findRow(listed, path)))).toEqual([
        'public document final',
        'public static',
        'private transient',
        'private volatile',
        'public synchronized',
        'public static final',
        'public document sealed',
        'public default',
        'public',
        'private',
    ]);
    expect(describeFlags(findRow(listed, ''))).toBe('');
});

test('java engine lists no row for members that Vineflower never writes', async () => {
    const { rows, paths } = await listFile(fixture.file);
    const names = (path: string) => rows.filter(row => row.parent === paths.indexOf(path)).map(row => row.name);

    expect(names('drawing.Main')).toEqual([
        'Cursor',
        'Entry',
        'GREETING',
        'hits',
        'done',
        'names',
        'Main',
        'classify',
        'describe',
        'count',
        'sum',
        'run',
        'parse',
    ]);
    expect(names('drawing.Color')).toEqual(['RED', 'GREEN', 'code', 'Color', 'code']);
    expect(names('drawing.Circle')).toEqual(['radius', 'Circle', 'area']);
    expect(names('drawing.Point')).toEqual(['x', 'y', 'Point']);
});

test('java engine counts the classes that it leaves out in the note', async () => {
    const anonymous = classFile({ name: 'a/B$1', innerClasses: [{ inner: 'a/B$1' }], enclosingClass: 'a/B' });
    const jar = zipFile([
        { name: 'a/C.class', bytes: classFile({ name: 'a/C' }) },
        { name: 'a/B$1.class', bytes: anonymous },
        { name: 'META-INF/versions/11/a/C.class', bytes: classFile({ name: 'a/C' }) },
        { name: 'lib/x.jar', bytes: new Uint8Array() },
        { name: 'lib/y.jar', bytes: new Uint8Array() },
    ]);

    expect((await listFile(fixture.file)).note).toBe('');
    expect((await listFile(new File([jar], 'app.jar'))).note).toBe(
        '1 class for newer Java versions, 2 nested JARs, and 1 local or anonymous class without its outer class not shown',
    );
});

test("java engine counts the classes that it can't read and a default package's class below a folder in the note", async () => {
    const jar = zipFile([
        { name: 'a/C.class', bytes: classFile({ name: 'a/C' }) },
        { name: 'a/D.class', bytes: new TextEncoder().encode('not a class') },
        { name: 'a/E.class', bytes: classFile({ name: 'a/E' }).subarray(0, 20) },
        { name: 'lib/F.class', bytes: classFile({ name: 'F' }) },
    ]);

    expect((await listFile(new File([jar], 'app.jar'))).note).toBe(
        "1 class whose name doesn't match its path and 2 classes that the engine can't read not shown",
    );
});
