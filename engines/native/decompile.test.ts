import { readTokens, type Token } from '#contract/document';
import type { Engine } from '#contract/engine';
import { readRows, type Row } from '#contract/rows';
import { modifiersOf } from '#contract/symbols';
import { expect, test } from 'bun:test';
import { LoadError } from '../shared/loading';
import { mountInMemory } from './files';
import { createNativeHandlers } from './handlers';
import type { NativeModule } from './module';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

interface OpenFile {
    engine: Engine;
    fileId: number;
    rows: Row[];
}

async function openFile(name: string): Promise<OpenFile> {
    const engine = connect();
    const file = await readFixture(name);
    const fileId = await engine.open(file.name, file);

    return { engine, fileId, rows: readRows(await engine.list(fileId)) };
}

function findKey({ rows }: OpenFile, name: string): number {
    const row = rows.find(candidate => candidate.name === name);
    if (!row) {
        throw new Error(`the file doesn't list ${name}`);
    }

    return row.key;
}

async function readFunction(file: OpenFile, name: string): Promise<{ text: string; tokens: Token[]; locals: string[] }> {
    const document = await file.engine.read(file.fileId, findKey(file, name), 'c');

    return { text: document.text, tokens: readTokens(document), locals: document.locals };
}

function findToken(text: string, tokens: Token[], word: string, index = 0): Token | undefined {
    return tokens.filter(token => text.slice(token.start, token.start + token.length) === word)[index];
}

test("read writes add with a declaration token, parameters as locals and a call's row target", async () => {
    const file = await openFile('shapes-x64.so');
    const add = await readFunction(file, 'add');
    const addTwice = await readFunction(file, 'add_twice');
    const addTarget = `${file.fileId}:${findKey(file, 'add').toString(16)}`;

    expect(add.text).toContain('add(int left, int right)');
    expect(findToken(add.text, add.tokens, 'add')).toMatchObject({ kind: 'method', target: addTarget });
    expect(modifiersOf(findToken(add.text, add.tokens, 'add')!.flags)).toEqual(['declaration']);
    expect(add.locals).toEqual(['int left', 'int right']);
    expect(findToken(add.text, add.tokens, 'left')).toMatchObject({ kind: 'parameter', target: 'L:0' });
    expect(findToken(addTwice.text, addTwice.tokens, 'add')).toMatchObject({ kind: 'method', flags: 0, target: addTarget });
}, 120000);

test('count_down has a label that its goto points at', async () => {
    const file = await openFile('shapes-x64.so');
    const { text, tokens, locals } = await readFunction(file, 'count_down');
    const label = locals.findIndex(local => /^loc_[0-9a-f]+$/.test(local));

    expect(text).toMatch(/goto loc_[0-9a-f]+;/);
    expect(tokens.filter(token => token.kind === 'label').map(token => [token.target, modifiersOf(token.flags)])).toEqual([
        [`L:${label}`, []],
        [`L:${label}`, ['declaration']],
    ]);
}, 120000);

test('a function above 64 kb gets its prototype and a note', async () => {
    const file = await openFile('big-x64.so');
    const { text, tokens } = await readFunction(file, 'big_sum');

    expect(text).toMatch(/^int big_sum\(int value\);\n\/\/ [\d,]+ bytes of code, more than the engine decompiles\.\n$/);
    const described = tokens.map(token => [text.slice(token.start, token.start + token.length), modifiersOf(token.flags)]);

    expect(described).toEqual([['big_sum', ['declaration']]]);
}, 120000);

test('x86, x86-64 and aarch64 files decompile', async () => {
    for (const name of ['shapes-x86.so', 'shapes-x64.so', 'shapes-a64.so']) {
        const { text } = await readFunction(await openFile(name), 'add');

        expect(text).toContain('add(');
        expect(text).toContain('return');
    }
}, 120000);

test('a function of a file at a high image base declares its row', async () => {
    const file = await openFile('extras-high.so');
    const { text, tokens } = await readFunction(file, 'extras_name');
    const token = findToken(text, tokens, 'extras_name');

    expect(token).toMatchObject({ kind: 'method', target: `${file.fileId}:${findKey(file, 'extras_name').toString(16)}` });
    expect(modifiersOf(token!.flags)).toEqual(['declaration']);
}, 120000);

test("a call of an imported function points at the import's row", async () => {
    const file = await openFile('extras-x64.so');
    const { text, tokens } = await readFunction(file, 'calls_external');
    const importTarget = `${file.fileId}:${(findKey(file, 'external_value') >>> 0).toString(16)}`;

    expect(findToken(text, tokens, 'external_value')).toMatchObject({ kind: 'method', flags: 0, target: importTarget });
}, 120000);

test("read refuses the code of a processor that the engine can't decompile", async () => {
    for (const [name, processor] of [
        ['extras-arm.so', '32-bit ARM'],
        ['extras-mips.so', 'MIPS'],
    ]) {
        const file = await openFile(name);
        const refusal = `The native engine can't decompile ${processor} code.`;

        await expect(file.engine.read(file.fileId, findKey(file, 'extras_name'), 'c')).rejects.toThrow(refusal);
    }
}, 120000);

test('read refuses an unknown key and an unknown view', async () => {
    const file = await openFile('shapes-x64.so');

    await expect(file.engine.read(file.fileId, 0x7777, 'c')).rejects.toThrow("shapes-x64.so doesn't have a symbol with the key 0x7777.");
    await expect(file.engine.read(file.fileId, findKey(file, 'add'), 'asm')).rejects.toThrow("The native engine doesn't have the view asm.");
}, 120000);

test("a failed fetch of a processor's language becomes a failed reply, and the next read fetches it again", async () => {
    const module = await loadTestModule();
    const refusal = "The native engine couldn't load sleigh/x86/x86-64.sla: 503 Service Unavailable";
    let isFailing = true;
    const flaky: NativeModule = {
        ...module,
        async fetchFile(path) {
            if (isFailing && path.endsWith('.sla')) {
                throw new LoadError(`The native engine couldn't load ${path}: 503 Service Unavailable`);
            }

            return module.fetchFile(path);
        },
    };
    const handlers = createNativeHandlers(async () => flaky, mountInMemory);
    const file = await readFixture('shapes-x64.so');
    const signal = new AbortController().signal;
    await handlers.open(1, file.name, file, signal);
    const add = readRows((await handlers.list(1, signal)).value!).find(row => row.name === 'add')!;

    expect(await handlers.read(1, add.key, 'c', signal)).toEqual({ error: refusal });
    isFailing = false;
    expect((await handlers.read(1, add.key, 'c', signal)).value?.text).toContain('add(');
}, 120000);

test("open starts the fetch of the processor's languages, so the first read doesn't fetch them", async () => {
    const module = await loadTestModule();
    const fetches: string[] = [];
    const watched: NativeModule = {
        ...module,
        async fetchFile(path) {
            fetches.push(path);

            return module.fetchFile(path);
        },
    };
    const handlers = createNativeHandlers(async () => watched, mountInMemory);
    const file = await readFixture('shapes-x64.so');
    const signal = new AbortController().signal;
    await handlers.open(1, file.name, file, signal);
    const add = readRows((await handlers.list(1, signal)).value!).find(row => row.name === 'add')!;
    const fetchedBeforeRead = [...fetches];

    expect((await handlers.read(1, add.key, 'c', signal)).value?.text).toContain('add(');
    expect(fetchedBeforeRead.filter(path => path.endsWith('.sla')).sort()).toEqual(['sleigh/x86/x86-64.sla', 'sleigh/x86/x86.sla']);
    expect(fetches).toEqual(fetchedBeforeRead);
}, 120000);
