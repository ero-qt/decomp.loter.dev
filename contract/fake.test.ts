import { expect, test } from 'bun:test';
import { readTokens, type Token } from './document';
import type { Engine } from './engine';
import { fakeManifest, sampleFiles } from './fake';
import { areaOutside, useFakeEngine } from './fake-testing';
import { readManifest } from './manifest';
import { EngineError } from './reply';
import { readRows } from './rows';
import { flagsOf } from './symbols';

const { drawing, shapes } = sampleFiles;
const circleKey = 2;
const drawKey = 5;
const notesMissingFile = { name: 'drawing.notes', reason: 'not loaded', isCompanion: true };
const shapesMissingFile = { name: 'shapes.fake', reason: 'not loaded', isCompanion: false };

const connect = useFakeEngine();

async function openDrawing(): Promise<[engine: Engine, drawingId: number]> {
    const engine = connect();

    return [engine, await engine.open(drawing.name, drawing)];
}

async function openText(text: string): Promise<[engine: Engine, fileId: number]> {
    const engine = connect();

    return [engine, await engine.open('written.fake', new File([text], 'written.fake'))];
}

async function readCircleTokens(engine: Engine, fileId: number, view: string): Promise<[string, Token][]> {
    const document = await engine.read(fileId, circleKey, view);

    return readTokens(document).map(token => [document.text.slice(token.start, token.start + token.length), token]);
}

test('fake file lists the file of a used symbol as a missing file until that file is open', async () => {
    const [engine, drawingId] = await openDrawing();

    expect((await engine.list(drawingId)).missingFiles).toEqual([notesMissingFile, shapesMissingFile]);

    await engine.open(shapes.name, shapes);

    expect((await engine.list(drawingId)).missingFiles).toEqual([notesMissingFile]);
});

test('fake file lists a needed file as a missing file until the page provides a file with that name', async () => {
    const [engine, drawingId] = await openDrawing();
    await engine.provide(drawingId, 'drawing.notes', new File(['a note'], 'drawing.notes'));

    expect((await engine.list(drawingId)).missingFiles).toEqual([shapesMissingFile]);
    await expect(engine.provide(drawingId, shapes.name, shapes)).rejects.toThrow(
        new EngineError("drawing.fake doesn't have a line 'needs shapes.fake'."),
    );
});

test('documents of a fake file end with a line for each companion that the page provided', async () => {
    const [engine, drawingId] = await openDrawing();
    await engine.provide(drawingId, 'drawing.notes', new File(['a note'], 'drawing_v2.notes'));

    expect((await engine.read(drawingId, circleKey, 'code')).text).toEndWith('enum_member Red = 1\nnotes drawing.notes\n');
    expect((await engine.read(drawingId, circleKey, 'ops')).text).toEndWith('\nnotes drawing.notes\n');
});

test("fake engine refuses a file with a line that the fake format doesn't have", async () => {
    await expect(openText('MZ')).rejects.toThrow(new EngineError("written.fake isn't a fake file."));
    await expect(openText('fake\npublic klass Circle')).rejects.toThrow(
        new EngineError("The fake engine can't read the line 'public klass Circle' of written.fake."),
    );
    await expect(openText('fake\n  public class Circle')).rejects.toThrow(EngineError);
    await expect(openText('fake\npublic class')).rejects.toThrow(EngineError);
    await expect(openText('fake\nshared class Circle')).rejects.toThrow(EngineError);
    await expect(openText('fake\nmethod Draw\n needs draw.notes')).rejects.toThrow(EngineError);
    await expect(openText('fake\nmethod Draw\n uses Shapes.Shape.Area')).rejects.toThrow(
        new EngineError("The fake engine can't read the line 'uses Shapes.Shape.Area' of written.fake."),
    );
});

test('fake engine reads a file whose lines end with a carriage return and a line feed', async () => {
    const [engine, fileId] = await openText('fake\r\nnote 2 lines\r\nclass Circle\r\n method Draw\r\n');
    const listing = await engine.list(fileId);

    expect(listing.note).toBe('2 lines');
    expect(readRows(listing).map(row => row.name)).toEqual(['Circle', 'Draw']);
});

test('fake engine reads an accessibility of 2 words', async () => {
    const [engine, fileId] = await openText('fake\nprivate protected class Circle\n protected internal static method Draw');

    expect(readRows(await engine.list(fileId)).map(row => row.flags)).toEqual([
        flagsOf('private protected', 'document'),
        flagsOf('protected internal', 'static'),
    ]);
    expect((await engine.read(fileId, 1, 'code')).text).toBe('private protected class Circle\n    protected internal static method Draw\n');
});

test("fake engine lists a file's note and rows, each row with a key of its own", async () => {
    const [engine, drawingId] = await openDrawing();
    const listing = await engine.list(drawingId);

    expect(listing.note).toBe('1 class left out');
    expect(readRows(listing)).toEqual([
        { kind: 'namespace', flags: 0, parent: -1, key: 1, name: 'Drawing', detail: '', hiddenViews: 0 },
        { kind: 'class', flags: flagsOf('public', 'sealed', 'document'), parent: 0, key: 2, name: 'Circle', detail: '', hiddenViews: 0 },
        { kind: 'field', flags: flagsOf('private', 'readonly'), parent: 1, key: 3, name: 'radius', detail: '', hiddenViews: 0 },
        { kind: 'constructor', flags: flagsOf('public'), parent: 1, key: 4, name: 'Circle', detail: '', hiddenViews: 0 },
        { kind: 'method', flags: flagsOf('public'), parent: 1, key: 5, name: 'Draw', detail: '', hiddenViews: 0 },
        { kind: 'enum', flags: flagsOf('private'), parent: 1, key: 6, name: 'Color', detail: '', hiddenViews: 0 },
        { kind: 'enum_member', flags: flagsOf('public', 'const'), parent: 5, key: 7, name: 'Red', detail: '= 1', hiddenViews: 0 },
    ]);
});

test('fake engine writes the document of the second class of a file', async () => {
    const [engine, fileId] = await openText('fake\nclass First\n method Draw\nclass Second\n method Area');

    expect((await engine.read(fileId, 3, 'code')).text).toBe('class Second\n    method Area\n');
});

test("fake engine leaves a hidden row's lines out of the view code and refuses a hidden row's document there", async () => {
    const [engine, fileId] = await openText('fake\nclass Box\n hidden private field backing\n  var value\nhidden class Secret');

    expect(readRows(await engine.list(fileId)).map(row => row.hiddenViews)).toEqual([0, 1, 1]);
    expect((await engine.read(fileId, 1, 'code')).text).toBe('class Box\n');
    expect((await engine.read(fileId, 1, 'ops')).text).toBe('.class Box\n    .private field backing\n        var value\n');
    await expect(engine.read(fileId, 3, 'code')).rejects.toThrow(new EngineError("Secret isn't in the view code."));
});

test('fake engine refuses the document of a namespace, of a member, of a key without a row and in another view', async () => {
    const [engine, drawingId] = await openDrawing();

    async function expectRefusal(key: number, view: string, text: string) {
        await expect(engine.read(drawingId, key, view)).rejects.toThrow(new EngineError(text));
    }

    await expectRefusal(1, 'code', "Drawing doesn't have its own document.");
    await expectRefusal(drawKey, 'code', "Draw doesn't have its own document.");
    await expectRefusal(99, 'code', "drawing.fake doesn't have a symbol with the key 99.");
    await expectRefusal(circleKey, 'il', "The fake engine doesn't have the view il.");
});

test('fake engine gives no document to a section or to the rows in it', async () => {
    const [engine, fileId] = await openText('fake\nsection References\n reference Shapes 1.0.0.0\nclass Box\n');

    expect(readRows(await engine.list(fileId)).map(row => [row.name, row.flags])).toEqual([
        ['References', 0],
        ['Shapes', 0],
        ['Box', flagsOf('', 'document')],
    ]);
});

test("document of a symbol has a line for each symbol inside that symbol and for each line of the symbols' code", async () => {
    const [engine, drawingId] = await openDrawing();
    const { text, locals } = await engine.read(drawingId, circleKey, 'code');

    expect(text).toBe(
        [
            'public sealed class Circle',
            '    private readonly field radius',
            '    public constructor Circle',
            '        uses Drawing.Circle.radius',
            '    public method Draw',
            '        var area',
            '        uses Shapes.Shape.Area',
            '        string "circle"',
            '    private enum Color',
            '        public const enum_member Red = 1',
            '',
        ].join('\n'),
    );
    expect(locals).toEqual(['var area']);
    expect((await engine.read(drawingId, circleKey, 'ops')).text).toStartWith('.public sealed class Circle\n    .private');
});

test('tokens of a document point at rows of the file, at a local and at a symbol outside the open files', async () => {
    const [engine, drawingId] = await openDrawing();
    const tokens = await readCircleTokens(engine, drawingId, 'code');

    expect(tokens.map(([text, { kind, target }]) => [text, kind, target])).toEqual([
        ['Circle', 'class', '1:2'],
        ['radius', 'field', '1:3'],
        ['Circle', 'constructor', '1:4'],
        ['Drawing.Circle.radius', 'field', '1:3'],
        ['Draw', 'method', '1:5'],
        ['area', 'local', 'L:0'],
        ['Shapes.Shape.Area', 'method', areaOutside],
        ['Color', 'enum', '1:6'],
        ['Red', 'enum_member', '1:7'],
    ]);
    expect(tokens[0][1].flags).toBe(flagsOf('public', 'sealed', 'declaration'));
    expect(tokens[3][1].flags).toBe(flagsOf('private', 'readonly'));
    expect(tokens[5][1].flags).toBe(flagsOf('', 'declaration'));
});

test('view `ops` has a token without a target on the first word of each line of code', async () => {
    const [engine, drawingId] = await openDrawing();
    const tokens = await readCircleTokens(engine, drawingId, 'ops');

    expect(tokens.filter(([, { kind }]) => kind === 'opcode').map(([text, { target }]) => [text, target])).toEqual([
        ['uses', null],
        ['var', null],
        ['uses', null],
        ['string', null],
    ]);
});

test('symbol outside the open files becomes a row of its file once that file is open', async () => {
    const [engine, drawingId] = await openDrawing();

    expect(await engine.resolve(areaOutside)).toBeNull();
    expect(await engine.describe(areaOutside, 'code')).toEqual({
        text: 'Shapes.Shape.Area',
        container: null,
        facts: [],
        missingFile: 'shapes.fake',
    });

    await engine.open(shapes.name, shapes);
    const tokens = await readCircleTokens(engine, drawingId, 'code');
    const [, used] = tokens.find(([text]) => text === 'Shapes.Shape.Area') ?? [];

    expect(await engine.resolve(areaOutside)).toBe('2:3');
    expect(used).toMatchObject({ target: '2:3', flags: flagsOf('public', 'abstract') });
});

test("fake engine describes a symbol outside the open files only with the symbol's file as the missing file", async () => {
    const [engine] = await openDrawing();

    expect(await engine.describe('|other.fake|Other.Shape', 'code')).toBeNull();
    expect(await engine.describe('|shapes.fake', 'code')).toBeNull();

    await engine.open(shapes.name, shapes);

    expect(await engine.describe('|shapes.fake|Shapes.Square', 'code')).toBeNull();
});

test("fake engine describes a row with the row's container and facts in the language of a view", async () => {
    const [engine] = await openDrawing();

    expect(await engine.describe('1:7', 'code')).toEqual({
        text: 'public const enum_member Red = 1',
        container: 'Drawing.Circle.Color',
        facts: [['file', 'drawing.fake'], ['key', '7']],
        missingFile: null,
    });
    expect((await engine.describe('1:7', 'ops'))?.text).toBe('.public const enum_member Red = 1');
    expect(await engine.describe('1:63', 'code')).toBeNull();
    expect(await engine.describe('L:0', 'code')).toBeNull();
});

test('fake engine finds the users of a symbol in every open file', async () => {
    const [engine] = await openDrawing();

    expect(await engine.findReferences(areaOutside, 'code')).toEqual([{ user: '1:5', ranges: null }]);
    expect(await engine.findReferences('1:3', 'code')).toEqual([{ user: '1:4', ranges: null }]);
    expect(await engine.findReferences('|area', 'code')).toEqual([]);

    await engine.open(shapes.name, shapes);

    expect(await engine.findReferences('2:3', 'code')).toEqual([{ user: '1:5', ranges: null }]);
    expect(await engine.findReferences('2:2', 'code')).toEqual([]);
});

test("fake engine returns the places of a symbol's uses in the view ops", async () => {
    const [engine] = await openDrawing();

    expect(await engine.findReferences(areaOutside, 'ops')).toEqual([{ user: '1:5', ranges: new Int32Array([6, 13, 17]) }]);
    expect(await engine.findReferences('1:3', 'ops')).toEqual([{ user: '1:4', ranges: new Int32Array([3, 13, 21]) }]);
});

test("fake engine refuses to find references in a view that the manifest doesn't have", async () => {
    const [engine] = await openDrawing();

    await expect(engine.findReferences('1:3', 'text')).rejects.toThrow(new EngineError("The fake engine doesn't have the view text."));
});

test('fake engine lists the strings of a file with the row that uses each string', async () => {
    const [engine, drawingId] = await openDrawing();

    expect(await engine.listStrings(drawingId)).toEqual([
        { text: 'drawing 1.0', user: null },
        { text: 'circle', user: '1:5' },
    ]);
});

test("fake engine's manifest has 2 views", () => {
    expect(readManifest(fakeManifest).views.map(view => view.id)).toEqual(['code', 'ops']);
});
