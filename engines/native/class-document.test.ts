import { expect, test } from 'bun:test';
import { readTokens, type Token, writeTokens } from '#contract/document';
import type { Engine } from '#contract/engine';
import { failed, ok } from '#contract/reply';
import { readRows, type Row } from '#contract/rows';
import { flagsOf, modifiersOf } from '#contract/symbols';
import { type ClassParts, writeClassDocument } from './class-document';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

interface OpenFile {
    engine: Engine;
    fileId: number;
    rows: Row[];
}

async function openShapes(): Promise<OpenFile> {
    const engine = connect();
    const file = await readFixture('shapes-x64.so');
    const fileId = await engine.open(file.name, file);

    return { engine, fileId, rows: readRows(await engine.list(fileId)) };
}

function findTarget({ fileId, rows }: OpenFile, name: string): string {
    return `${fileId}:${(rows.find(row => row.name === name)!.key >>> 0).toString(16)}`;
}

async function readClass(file: OpenFile, name: string): Promise<{ text: string; tokens: Token[]; locals: string[] }> {
    const row = file.rows.find(candidate => candidate.name === name && candidate.kind === 'class')!;
    const document = await file.engine.read(file.fileId, row.key, 'c');

    return { text: document.text, tokens: readTokens(document), locals: document.locals };
}

function listDeclared(tokens: Token[]): (string | null)[] {
    return tokens.filter(token => modifiersOf(token.flags).includes('declaration') && !token.target?.startsWith('L:')).map(token => token.target);
}

test("Rect's document declares Rect, its methods and its static member", async () => {
    const file = await openShapes();
    const { text, tokens, locals } = await readClass(file, 'Rect');

    expect(text).toStartWith('struct Rect {\n    int width_;\n');
    expect(text).toContain('geometry::Rect::area(');
    expect(text).toContain('geometry::Rect::corner(');
    expect(text).toContain('extern undefined4 geometry::Rect::count; // 0x3c68\n');
    expect(text.indexOf('geometry::Rect::area(')).toBeLessThan(text.indexOf('geometry::Rect::corner('));
    expect(listDeclared(tokens)).toEqual(['Rect', 'count', 'area', 'corner'].map(name => findTarget(file, name)));
    expect(locals.filter(local => /\bthis$/.test(local))).toEqual(['Rect *this', 'Rect *this']);
}, 120000);

test('a nested class has its own document', async () => {
    const file = await openShapes();
    const rect = await readClass(file, 'Rect');
    const corner = await readClass(file, 'Corner');

    expect(rect.text).not.toContain('distance(');
    expect(corner.text).toStartWith('struct Corner {\n');
    expect(listDeclared(corner.tokens)).toEqual(['Corner', 'distance'].map(name => findTarget(file, name)));
}, 120000);

test("a method that can't be decompiled leaves a comment with its error in its class's document", async () => {
    const parts: ClassParts = {
        fileId: 2,
        key: 0x84000000 | 0,
        fullName: 'geometry::Rect',
        definition: undefined,
        statics: [],
        methods: [
            { key: 0x10, name: 'area', kind: 'method' },
            { key: 0x20, name: 'corner', kind: 'method' },
        ],
    };
    const corner = writeTokens('int corner(void);\n', [], []);
    const readMethod = (key: number) => (key === 0x10 ? failed("Ghidra can't decompile the function at 0x1010.") : ok(corner));
    const document = (await writeClassDocument(parts, readMethod, new AbortController().signal)).value!;
    const comment = "// geometry::Rect::area: Ghidra can't decompile the function at 0x1010.\n";

    expect(document.text).toBe(`// class geometry::Rect\n\n${comment}\nint corner(void);\n`);
    expect(readTokens(document)[1]).toEqual({ start: 28, length: 20, kind: 'method', flags: flagsOf('', 'declaration'), target: '2:10' });
});
