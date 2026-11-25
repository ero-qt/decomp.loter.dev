import { findRow } from '#contract/checking';
import { type Document, formatTarget, readTokens, type Token } from '#contract/document';
import type { Engine } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { findDocumentRow, readRows, type Row } from '#contract/rows';
import { modifiersOf } from '#contract/symbols';
import { expect, test } from 'bun:test';
import { compileAssembly, loadTestRuntime, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

const area = '|Shapes|M:Shapes.Shape.Area';

interface OpenAssembly {
    fileId: number;
    rows: Row[];
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
        targetOf: path => formatTarget({ fileId, key: keyOf(path) }),
        read: path => engine.read(fileId, keyOf(path), 'il'),
    };
}

function textOf(document: Document, { start, length }: Token): string {
    return document.text.slice(start, start + length);
}

function isDeclaration(token: Token): boolean {
    return modifiersOf(token.flags).includes('declaration');
}

// finds the offset of each instruction's start in the text, like the `I` of `IL_0000: ldarg.0`
function findInstructionStarts(text: string): number[] {
    return [...text.matchAll(/^[ \t]*(IL_[0-9a-f]{4}): /gm)].map(match => match.index + match[0].indexOf('IL_'));
}

test('IL of Painter has an opcode token for each instruction and a label for each branch target', async () => {
    const painter = await (await openAssembly(connect(), 'Drawing.dll')).read('Drawing.Painter');
    const tokens = readTokens(painter);
    const instructionStarts = findInstructionStarts(painter.text);
    const opcodes = tokens.filter(token => token.kind === 'opcode');
    const branchLabels = tokens.filter(token => token.kind === 'label' && !isDeclaration(token));

    expect(painter.text).toContain('.class public auto ansi beforefieldinit Drawing.Painter');
    expect(opcodes.length).toBe(instructionStarts.length);
    expect(opcodes.map(token => textOf(painter, token))).toContain('callvirt');
    expect(branchLabels.length).toBeGreaterThan(0);
    for (const label of branchLabels) {
        const declaration = tokens.find(token => token.target === label.target && isDeclaration(token));

        expect(label.target).toMatch(/^L:\d+$/);
        expect(declaration && textOf(painter, declaration)).toBe(textOf(painter, label));
        expect(instructionStarts).toContain(declaration!.start);
    }
});

test('IL of every type of both fixture files declares each of its rows, also the rows that C# hides', async () => {
    const engine = connect();
    const missing: string[] = [];
    for (const name of ['Drawing.dll', 'Shapes.dll']) {
        const { fileId, rows } = await openAssembly(engine, name);
        const documents = new Map<number, Token[]>();
        for (const [index, row] of rows.entries()) {
            const documentIndex = findDocumentRow(rows, index);
            if (documentIndex === undefined) {
                continue;
            }
            if (!documents.has(documentIndex)) {
                documents.set(documentIndex, readTokens(await engine.read(fileId, rows[documentIndex].key, 'il')));
            }

            const target = formatTarget({ fileId, key: row.key });
            if (!documents.get(documentIndex)!.some(token => token.target === target && isDeclaration(token))) {
                missing.push(`${name} ${row.name}`);
            }
        }
    }

    expect(missing).toEqual([]);
});

test('IL declares a field named like the keyword assembly at its name, not at its accessibility', async () => {
    const engine = connect();
    const file = await compileAssembly('Keyword', 'public class Holder { internal int assembly; }');
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));
    const holder = await engine.read(fileId, findRow(rows, 'Holder', file.name).key, 'il');
    const field = formatTarget({ fileId, key: findRow(rows, 'Holder.assembly', file.name).key });
    const declaration = readTokens(holder).find(token => token.target === field && isDeclaration(token))!;

    expect(holder.text).toContain(".field assembly int32 'assembly'");
    expect(textOf(holder, declaration)).toBe("'assembly'");
});

test('IL declares parameters and locals with their names in the locals and declares every local that it uses', async () => {
    const painter = await (await openAssembly(connect(), 'Drawing.dll')).read('Drawing.Painter');
    const tokens = readTokens(painter);
    const shape = tokens.find(token => token.kind === 'parameter' && textOf(painter, token) === 'shape');
    const localTargets = new Set(tokens.flatMap(token => (token.target?.startsWith('L:') ? [token.target] : [])));

    expect(shape && isDeclaration(shape)).toBe(true);
    expect(painter.locals[Number(shape!.target!.slice(2))]).toBe('shape');
    expect(tokens.some(token => token.kind === 'local' && isDeclaration(token))).toBe(true);
    expect([...localTargets].filter(target => !tokens.some(token => token.target === target && isDeclaration(token)))).toEqual([]);
});

test('IL points a field of its own file at its row and a call of Shape.Area at its outside target until Shapes.dll is open', async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, 'Drawing.dll');
    const canvas = await drawing.read('Drawing.Canvas');
    const painter = await drawing.read('Drawing.Painter');
    const created = readTokens(canvas).filter(token => token.target === drawing.targetOf('Drawing.Canvas.created'));

    expect(created.map(token => [token.kind, textOf(canvas, token)])).toContainEqual(['field', 'created']);
    expect(readTokens(painter).filter(token => token.target === area).map(token => token.kind)).toEqual(['method']);

    const shapes = await openAssembly(engine, 'Shapes.dll');
    const reread = await drawing.read('Drawing.Painter');
    const areaRow = shapes.targetOf('Shapes.Shape.Area()');

    expect(readTokens(reread).filter(token => token.target === areaRow).map(token => textOf(reread, token))).toEqual(['Area']);
});

test('dotnet engine describes a row in the view il with its IL header', async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, 'Drawing.dll');

    expect(await engine.describe(drawing.targetOf('Drawing.Painter.Paint(Shape)'), 'il')).toMatchObject({
        text: expect.stringMatching(/^\.method public hidebysig\s+instance void Paint \(/),
        container: 'Drawing.Painter',
        facts: [
            ['token', '0x0600000C'],
            ['RVA', expect.stringMatching(/^0x[0-9A-F]{4,}$/)],
        ],
    });
    const painter = await engine.describe(drawing.targetOf('Drawing.Painter'), 'il');

    expect(painter?.text).toMatch(/^\.class public auto ansi beforefieldinit Drawing\.Painter/);
    expect(await engine.findReferences(area, 'il')).toEqual(await engine.findReferences(area, 'csharp'));
});

test("dotnet engine refuses the IL of a row without its own document and of a key that isn't a row's", async () => {
    const engine = connect();
    const drawing = await openAssembly(engine, 'Drawing.dll');
    const refusals = [
        engine.read(drawing.fileId, 0x02ffffff, 'il'),
        engine.read(drawing.fileId, findRow(drawing.rows, 'Drawing.Painter.Brush', 'Drawing.dll').key, 'il'),
        engine.read(drawing.fileId, findRow(drawing.rows, 'Drawing', 'Drawing.dll').key, 'il'),
    ];

    for (const refusal of refusals) {
        await expect(refusal).rejects.toBeInstanceOf(EngineError);
    }
});
