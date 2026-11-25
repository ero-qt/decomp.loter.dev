import { findRow, missingView } from '#contract/checking';
import { type Document, formatTarget, readTokens, type Token } from '#contract/document';
import type { Engine } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { findDocumentRow, readRows, type Row } from '#contract/rows';
import { modifiersOf } from '#contract/symbols';
import { expect, mock, setDefaultTimeout, spyOn, test } from 'bun:test';
import { fixture } from './fixture';
import { useJavaEngine } from './testing';
import * as tokens from './tokens';

const connect = useJavaEngine();
setDefaultTimeout(60000);

interface OpenJar {
    fileId: number;
    rows: Row[];
    targetOf(path: string): string;
    read(path: string): Promise<Document>;
}

async function openJar(engine: Engine, file: File): Promise<OpenJar> {
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));
    const targetOf = (path: string) => formatTarget({ fileId, key: findRow(rows, path, file.name).key });

    return { fileId, rows, targetOf, read: path => engine.read(fileId, findRow(rows, path, file.name).key, 'java') };
}

// finds the tokens whose text is the word, in the text's order
function findTokens(document: Document, word: string): Token[] {
    return readTokens(document).filter(({ start, length }) => document.text.slice(start, start + length) === word);
}

function isDeclaration(token: Token | undefined): boolean {
    return token !== undefined && modifiersOf(token.flags).includes('declaration');
}

test("java engine's documents declare every row of both fixture JARs", async () => {
    const engine = connect();
    const missing: string[] = [];
    for (const file of [fixture.file, fixture.linked.file]) {
        const { fileId, rows } = await openJar(engine, file);
        const documents = new Map<number, Token[]>();
        for (const [index, row] of rows.entries()) {
            const documentIndex = findDocumentRow(rows, index);
            if (documentIndex === undefined) {
                continue;
            }
            if (!documents.has(documentIndex)) {
                documents.set(documentIndex, readTokens(await engine.read(fileId, rows[documentIndex].key, 'java')));
            }

            const target = formatTarget({ fileId, key: row.key });
            if (!documents.get(documentIndex)!.some(token => token.target === target && isDeclaration(token))) {
                missing.push(`${file.name} ${row.name}${row.detail}`);
            }
        }
    }

    expect(missing).toEqual([]);
});

test('java engine writes records, sealed interfaces, pattern switches and anonymous classes', async () => {
    const jar = await openJar(connect(), fixture.file);
    const main = (await jar.read('drawing.Main')).text;

    expect((await jar.read('drawing.Circle')).text).toContain('public record Circle(double radius) implements Shape {\n');
    expect((await jar.read('drawing.Named')).text).toContain('public sealed interface Named permits Color, Level {\n');
    expect(main).toContain('        return switch (value) {\n            case Circle circle -> "circle of " + circle.radius() + " cm";\n');
    expect(main).toContain('        Runnable task = new Runnable() {\n');
    expect(main.endsWith('}\n')).toBe(true);
});

test('java engine points the tokens of JDK symbols at their keys outside the open files', async () => {
    const main = await (await openJar(connect(), fixture.file)).read('drawing.Main');

    expect(findTokens(main, 'String')[0]).toMatchObject({ kind: 'class', target: '|java/lang/String' });
    expect(findTokens(main, 'trim')).toMatchObject([{ kind: 'method', target: '|java/lang/String#trim#()Ljava/lang/String;' }]);
});

test('java engine writes the declarations of parameters and locals and declares a catch variable at its first use', async () => {
    const main = await (await openJar(connect(), fixture.file)).read('drawing.Main');
    const localOf = (word: string) => main.locals[Number(findTokens(main, word)[0].target!.slice(2))];

    expect(['shape', 'values', 'total', 'name'].map(localOf)).toEqual(['Shape shape', 'int[] values', 'int total', 'String name']);
    expect(isDeclaration(findTokens(main, 'error')[0])).toBe(true);
    expect(findTokens(main, 'error')[0].target).toStartWith('L:');
});

test("java engine points a record's accessor and its constructor's parameters at the component's row", async () => {
    const jar = await openJar(connect(), fixture.file);
    const circle = await jar.read('drawing.Circle');
    const main = await jar.read('drawing.Main');
    const radius = jar.targetOf('drawing.Circle.radius');

    expect(findTokens(circle, 'radius').map(token => token.target)).toEqual([radius, radius, radius, radius]);
    expect(findTokens(main, 'radius')).toMatchObject([{ kind: 'field', target: radius }]);
});

test("java engine points an inherited field at the base class's row in another open JAR", async () => {
    const engine = connect();
    const drawing = await openJar(engine, fixture.file);
    const shapes = await openJar(engine, fixture.linked.file);

    expect(findTokens(await drawing.read('drawing.Box'), 'sides')).toMatchObject([{ kind: 'field', target: shapes.targetOf('shapes.Base.sides') }]);
});

test("java engine refuses to read a closed file, a view that it doesn't have, a missing key and a row without its own document", async () => {
    const engine = connect();
    const { fileId, rows } = await openJar(engine, fixture.file);
    const main = findRow(rows, 'drawing.Main', fixture.file.name).key;
    const classify = findRow(rows, 'drawing.Main.classify', fixture.file.name).key;
    const refusals = [
        engine.read(fileId, main, missingView),
        engine.read(fileId, rows.length, 'java'),
        engine.read(fileId, classify, 'java'),
        engine.read(fileId, findRow(rows, 'drawing', fixture.file.name).key, 'java'),
    ];
    for (const refusal of refusals) {
        await expect(refusal).rejects.toBeInstanceOf(EngineError);
    }

    await engine.close(fileId);
    await expect(engine.read(fileId, main, 'java')).rejects.toBeInstanceOf(EngineError);
});

test("java engine refuses a read whose tokens it can't map", async () => {
    const jar = await openJar(connect(), fixture.file);
    spyOn(tokens, 'mapTokens').mockRejectedValue(new Error('The token is broken.'));

    try {
        await expect(jar.read('drawing.Point')).rejects.toBeInstanceOf(EngineError);
    } finally {
        mock.restore();
    }
});
