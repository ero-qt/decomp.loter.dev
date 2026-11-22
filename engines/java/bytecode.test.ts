import { expect, setDefaultTimeout, test } from 'bun:test';
import { findRow } from '../../contract/checking';
import { type Document, formatTarget, readTokens } from '../../contract/document';
import type { Engine } from '../../contract/engine';
import { findDocumentRow, readRows, type Row } from '../../contract/rows';
import { modifiersOf } from '../../contract/symbols';
import { fixture } from './fixture';
import { createJavaHandlers } from './handlers';
import { useJavaEngine } from './testing';

const connect = useJavaEngine();
setDefaultTimeout(60000);

async function readBytecode(engine: Engine, file: File, path: string): Promise<Document> {
    const fileId = await engine.open(file.name, file);
    const rows: Row[] = readRows(await engine.list(fileId));

    return engine.read(fileId, findRow(rows, path, file.name).key, 'bytecode');
}

test("java engine's bytecode of Main has the call of String's trim in Main's lambda", async () => {
    const main = await readBytecode(connect(), fixture.file, 'drawing.Main');

    expect(main.text).toContain('        //  4: invokevirtual java/lang/String trim ()Ljava/lang/String;\n');
});

test("java engine's bytecode documents declare every row of both fixture JARs", async () => {
    const engine = connect();
    const missing: string[] = [];
    for (const file of [fixture.file, fixture.linked.file]) {
        const fileId = await engine.open(file.name, file);
        const rows = readRows(await engine.list(fileId));
        for (const [index, row] of rows.entries()) {
            const documentIndex = findDocumentRow(rows, index);
            if (documentIndex === undefined) {
                continue;
            }

            const target = formatTarget({ fileId, key: row.key });
            const tokens = readTokens(await engine.read(fileId, rows[documentIndex].key, 'bytecode'));
            if (!tokens.some(token => token.target === target && modifiersOf(token.flags).includes('declaration'))) {
                missing.push(`${file.name} ${row.name}${row.detail}`);
            }
        }
    }

    expect(missing).toEqual([]);
});

test("java engine's bytecode of Main declares Main's nested classes and their members after Main", async () => {
    const main = await readBytecode(connect(), fixture.file, 'drawing.Main');
    const declared = readTokens(main).filter(token => modifiersOf(token.flags).includes('declaration'));
    const words = declared.map(({ start, length }) => main.text.slice(start, start + length));

    expect(words.slice(0, 2)).toEqual(['Main', 'GREETING']);
    expect(words).toContain('Main$Entry');
    expect(words.indexOf('key')).toBeGreaterThan(words.indexOf('Main$Entry'));
    expect(main.text.endsWith('}\n')).toBe(true);
});

// finds the token on the first line with the line's text whose own text is the word
function findLineToken(document: Document, lineText: string, word: string) {
    const lineStart = document.text.indexOf(lineText);
    const start = document.text.indexOf(word, lineStart);

    return lineStart < 0 ? undefined : readTokens(document).find(token => token.start === start && token.length === word.length);
}

test("java engine's bytecode points an instruction's member and class at their rows, also in another open JAR", async () => {
    const engine = connect();
    const drawingId = await engine.open(fixture.file.name, fixture.file);
    const shapesId = await engine.open(fixture.linked.file.name, fixture.linked.file);
    const drawingRows = readRows(await engine.list(drawingId));
    const shapesRows = readRows(await engine.list(shapesId));
    const main = await engine.read(drawingId, findRow(drawingRows, 'drawing.Main', fixture.file.name).key, 'bytecode');
    const area = formatTarget({ fileId: shapesId, key: findRow(shapesRows, 'shapes.Shape.area', fixture.linked.file.name).key });
    const names = formatTarget({ fileId: drawingId, key: findRow(drawingRows, 'drawing.Main.names', fixture.file.name).key });
    const point = formatTarget({ fileId: drawingId, key: findRow(drawingRows, 'drawing.Point', fixture.file.name).key });

    const areaToken = findLineToken(main, 'invokeinterface shapes/Shape area ()D', 'area');

    expect(areaToken).toMatchObject({ kind: 'method', target: area });
    expect(modifiersOf(areaToken!.flags)).not.toContain('declaration');
    expect(findLineToken(main, 'putfield drawing/Main names', 'names')).toMatchObject({ kind: 'field', target: names });
    expect(findLineToken(main, 'checkcast drawing/Point', 'drawing/Point')).toMatchObject({ target: point });
    expect((await engine.findReferences(area, 'bytecode')).map(reference => reference.user)).toContain(
        formatTarget({ fileId: drawingId, key: findRow(drawingRows, 'drawing.Main', fixture.file.name).key }),
    );
});

test("java engine's bytecode of Main writes the source file, the package and the imports of Main and its nested classes once", async () => {
    const { text } = await readBytecode(connect(), fixture.file, 'drawing.Main');
    const head = text.slice(0, text.indexOf('public final super class Main'));

    expect(text.split('// Source file: ').length).toBe(2);
    expect(text.split('package drawing;').length).toBe(2);
    expect(head).toStartWith('// Source file: Main.java\npackage drawing;\n\nimport java.lang.Object;\n');
    expect(head).toContain('import java.lang.Runnable;\n');
    expect(head).not.toContain('import drawing.Main;\n');
    expect(text.split('import java.lang.Object;').length).toBe(2);
});

test('java engine stops a bytecode read once its signal aborts', async () => {
    const handlers = createJavaHandlers();
    const signal = new AbortController().signal;
    await handlers.open(1, fixture.file.name, fixture.file, signal);
    const rows = readRows((await handlers.list(1, signal)).value!);

    await expect(handlers.read(1, findRow(rows, 'drawing.Main', fixture.file.name).key, 'bytecode', AbortSignal.abort())).rejects.toThrow('aborted');
});
