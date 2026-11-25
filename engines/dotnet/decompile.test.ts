import { expect, test } from 'bun:test';
import { findRow } from '#contract/checking';
import { type Document, formatTarget, readTokens, type Token } from '#contract/document';
import type { Engine } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { findDocumentRow, readRows, type Row } from '#contract/rows';
import { modifiersOf } from '#contract/symbols';
import { compileAssembly, loadTestRuntime, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

interface OpenAssembly {
    fileId: number;
    rows: Row[];
    keyOf(path: string): number;
    targetOf(path: string): string;
    read(path: string): Promise<Document>;
}

async function openAssembly(engine: Engine, name: string): Promise<OpenAssembly> {
    const file = await readFixture(name);
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));
    const keyOf = (path: string) => findRow(rows, path, file.name).key;

    return {
        fileId,
        rows,
        keyOf,
        targetOf: path => formatTarget({ fileId, key: keyOf(path) }),
        read: path => engine.read(fileId, keyOf(path), 'csharp'),
    };
}

// finds the tokens whose text is the word, in the text's order
function findTokens(document: Document, word: string): Token[] {
    return readTokens(document).filter(({ start, length }) => document.text.slice(start, start + length) === word);
}

function isDeclaration(token: Token): boolean {
    return modifiersOf(token.flags).includes('declaration');
}

function findDeclaration(document: Document, target: string): Token | undefined {
    return readTokens(document).find(token => token.target === target && isDeclaration(token));
}

test('C# of Painter declares the type and each of its rows', async () => {
    const drawing = await openAssembly(connect(), 'Drawing.dll');
    const painter = await drawing.read('Drawing.Painter');
    const painterIndex = drawing.rows.findIndex(row => row.key === drawing.keyOf('Drawing.Painter'));
    const painterRows = drawing.rows.filter((row, index) => findDocumentRow(drawing.rows, index) === painterIndex && row.hiddenViews === 0);

    expect(painter.text).toContain('public class Painter\n');
    expect(painterRows.map(row => row.name)).toContain('Brush');
    const undeclared = painterRows
        .filter(row => !findDeclaration(painter, formatTarget({ fileId: drawing.fileId, key: row.key })))
        .map(row => row.name);

    expect(undeclared).toEqual([]);
});

test("C# of every type of both fixture files declares each of its rows that the view csharp doesn't hide", async () => {
    const engine = connect();
    const missing: string[] = [];
    for (const name of ['Drawing.dll', 'Shapes.dll']) {
        const { fileId, rows } = await openAssembly(engine, name);
        const documents = new Map<number, Document>();
        for (const [index, row] of rows.entries()) {
            const documentIndex = findDocumentRow(rows, index);
            if (documentIndex === undefined || row.hiddenViews & 1) {
                continue;
            }
            if (!documents.has(documentIndex)) {
                documents.set(documentIndex, await engine.read(fileId, rows[documentIndex].key, 'csharp'));
            }
            if (!findDeclaration(documents.get(documentIndex)!, formatTarget({ fileId, key: row.key }))) {
                missing.push(`${name} ${row.name}`);
            }
        }
    }

    expect(missing).toEqual([]);
});

test("C# of Painter declares no row that the view csharp hides, like the field of the event Painted", async () => {
    const drawing = await openAssembly(connect(), 'Drawing.dll');
    const painter = await drawing.read('Drawing.Painter');
    const hiddenTargets = drawing.rows.filter(row => row.hiddenViews & 1).map(row => formatTarget({ fileId: drawing.fileId, key: row.key }));

    expect(hiddenTargets.length).toBeGreaterThan(0);
    expect(readTokens(painter).filter(token => isDeclaration(token) && hiddenTargets.includes(token.target ?? ''))).toEqual([]);
});

test('C# declares operators at their operator keyword and an indexer at its this keyword', async () => {
    const engine = connect();
    const shapes = await openAssembly(engine, 'Shapes.dll');
    const drawing = await openAssembly(engine, 'Drawing.dll');
    const point = await shapes.read('Shapes.Point');
    const canvas = await drawing.read('Drawing.Canvas');
    const textOf = (document: Document, token: Token | undefined) => token && document.text.slice(token.start, token.start + token.length);

    expect(textOf(point, findDeclaration(point, shapes.targetOf('Shapes.Point.operator +(Point, Point)')))).toBe('operator');
    expect(findDeclaration(point, shapes.targetOf('Shapes.Point.implicit operator Point(int)'))).toMatchObject({ kind: 'operator' });
    expect(textOf(canvas, findDeclaration(canvas, drawing.targetOf('Drawing.Canvas.this[int]')))).toBe('this');
});

test('C# declares parameters, locals and local functions with their declarations in the locals', async () => {
    const painter = await (await openAssembly(connect(), 'Drawing.dll')).read('Drawing.Painter');
    const localOf = (word: string) => painter.locals[Number(findTokens(painter, word)[0].target!.slice(2))];
    const localTargets = new Set(readTokens(painter).flatMap(token => (token.target?.startsWith('L:') ? [token.target] : [])));

    expect(['values', 'num', 'Add', 'factor'].map(localOf)).toEqual(['int[] values', 'int num', 'int Add(int total, int num2)', 'int factor']);
    expect(isDeclaration(findTokens(painter, 'values')[0])).toBe(true);
    expect([...localTargets].filter(target => !findDeclaration(painter, target))).toEqual([]);
});

test("C# points a call of Shape.Area at its symbol outside the open files while Shapes.dll isn't open", async () => {
    const painter = await (await openAssembly(connect(), 'Drawing.dll')).read('Drawing.Painter');

    expect(findTokens(painter, 'Area')).toMatchObject([{ kind: 'method', target: '|Shapes|M:Shapes.Shape.Area' }]);
    expect(findTokens(painter, 'Shape')[0]).toMatchObject({ kind: 'class', target: '|Shapes|T:Shapes.Shape' });
});

test('C# points a call of Shape.Area at its row once Shapes.dll is open', async () => {
    const engine = connect();
    const shapes = await openAssembly(engine, 'Shapes.dll');
    const painter = await (await openAssembly(engine, 'Drawing.dll')).read('Drawing.Painter');

    expect(findTokens(painter, 'Area')).toMatchObject([{ kind: 'method', target: shapes.targetOf('Shapes.Shape.Area()') }]);
});

const boxText = 'namespace Lib { public static class Box<T> { public static void Put(T value) { } } }';
const userText = 'public class User { public void Run() { Lib.Box<int>.Put(1); Lib.Box<string>.Put(""); } }';

// compiles Box<T> into the library and reads the C# of User, which uses Box<int> and Box<string>, while the library
// isn't open
async function readUser(engine: Engine, library: string): Promise<{ user: Document; library: File }> {
    const libraryFile = await compileAssembly(library, boxText);
    const userFile = await compileAssembly(`${library}User`, userText, [library]);
    const fileId = await engine.open(userFile.name, userFile);
    const key = findRow(readRows(await engine.list(fileId)), 'User', userFile.name).key;

    return { user: await engine.read(fileId, key, 'csharp'), library: libraryFile };
}

test('C# points the uses of a generic outside type with 2 type arguments at 1 target that resolves once the type opens', async () => {
    const engine = connect();
    const { user, library } = await readUser(engine, 'Generic');
    const targets = [...new Set(findTokens(user, 'Put').map(token => token.target))];

    expect(targets).toEqual(['|Generic|M:Lib.Box`1.Put(`0)']);

    const libraryId = await engine.open(library.name, library);
    const put = findRow(readRows(await engine.list(libraryId)), 'Lib.Box<T>.Put(T)', library.name).key;

    expect(await engine.resolve(targets[0]!)).toBe(formatTarget({ fileId: libraryId, key: put }));
});

test("C# doesn't point at the symbols of an outside assembly whose name has the target's separator |", async () => {
    const { user } = await readUser(connect(), 'Pipe|Name');

    expect(findTokens(user, 'Put').map(token => token.target)).toEqual([null, null]);
    expect(findTokens(user, 'Box').map(token => token.target)).toEqual([null, null]);
});

test('dotnet engine refuses to read a document row in a view that hides it and reads it in the view il', async () => {
    const engine = connect();
    const file = await compileAssembly('Hidden', 'public static class Table { public static int[] Data = { 1, 2, 3, 4, 5, 6, 7, 8 }; }');
    const fileId = await engine.open(file.name, file);
    const details = readRows(await engine.list(fileId)).find(row => row.name === '<PrivateImplementationDetails>')!;

    expect(details.hiddenViews).toBe(1);
    await expect(engine.read(fileId, details.key, 'csharp')).rejects.toThrow("is hidden in the view csharp");
    expect((await engine.read(fileId, details.key, 'il')).text).toContain('<PrivateImplementationDetails>');
});

test("dotnet engine refuses to read a missing key, a row without its own document, a view that it doesn't have and a closed file", async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, 'Drawing.dll');
    const painter = drawing.keyOf('Drawing.Painter');
    const refusals = [
        engine.read(drawing.fileId, 0x02ffffff, 'csharp'),
        engine.read(drawing.fileId, drawing.keyOf('Drawing.Painter.Paint(Shape)'), 'csharp'),
        engine.read(drawing.fileId, drawing.keyOf('Drawing.Painter.Brush'), 'csharp'),
        engine.read(drawing.fileId, drawing.keyOf('Drawing'), 'csharp'),
        engine.read(drawing.fileId, painter, 'vb'),
    ];
    for (const refusal of refusals) {
        await expect(refusal).rejects.toBeInstanceOf(EngineError);
    }

    await engine.close(drawing.fileId);
    await expect(engine.read(drawing.fileId, painter, 'csharp')).rejects.toBeInstanceOf(EngineError);
});
