import { expect, test } from 'bun:test';
import { readTokens, type Token } from '#contract/document';
import type { Engine } from '#contract/engine';
import { readRows, type Row } from '#contract/rows';
import { modifiersOf } from '#contract/symbols';
import { disassembleFunction } from './disassembly';
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

function findToken(text: string, tokens: Token[], word: string, index = 0): Token | undefined {
    return tokens.filter(token => text.slice(token.start, token.start + token.length) === word)[index];
}

async function readDisassembly(file: OpenFile, name: string): Promise<{ text: string; tokens: Token[]; locals: string[] }> {
    const document = await file.engine.read(file.fileId, findKey(file, name), 'assembly');

    return { text: document.text, tokens: readTokens(document), locals: document.locals };
}

test("disassembly of add shows its ret after the ret's address", async () => {
    const { text } = await readDisassembly(await openFile('shapes-x64.so'), 'add');

    expect(text).toContain('\n00001a23  ret\n');
}, 120000);

test("disassembly of add starts with add's signature, whose name declares add's row", async () => {
    const file = await openFile('shapes-x64.so');
    const { text, tokens } = await readDisassembly(file, 'add');
    const token = findToken(text, tokens, 'add');

    expect(text).toStartWith('; int add(int left, int right)\n');
    expect(token).toMatchObject({ start: '; int '.length, kind: 'method', target: `${file.fileId}:${findKey(file, 'add').toString(16)}` });
    expect(modifiersOf(token!.flags)).toEqual(['declaration']);
}, 120000);

test("a call in rect_area's disassembly shows the callee's full name and points at the callee's row", async () => {
    const file = await openFile('shapes-x64.so');
    const { text, tokens } = await readDisassembly(file, 'rect_area');

    expect(text).toContain('  call geometry::Rect::area\n');
    expect(findToken(text, tokens, 'geometry::Rect::area')).toMatchObject({
        kind: 'method',
        flags: 0,
        target: `${file.fileId}:${findKey(file, 'area').toString(16)}`,
    });
}, 120000);

test("a jump inside count_down shows a label, which the address of the jump's target line declares", async () => {
    const { text, tokens, locals } = await readDisassembly(await openFile('shapes-x64.so'), 'count_down');
    const label = locals.indexOf('loc_1b3e');
    const described = tokens.filter(token => token.target === `L:${label}`).map(token => {
        return [text.slice(token.start, token.start + token.length), token.kind, modifiersOf(token.flags)];
    });

    expect(text).toContain('  jnle loc_1b3e\n');
    expect(described).toEqual([
        ['loc_1b3e', 'label', []],
        ['00001b3e', 'label', ['declaration']],
    ]);
}, 120000);

// disassembles the function at an address of a fixture's file in a session of its own, with `findRow` finding no row
async function disassembleAt(name: string, address: bigint, maxBytes: number): Promise<string | undefined> {
    const module = await loadTestModule();
    const file = await readFixture(name);
    const mounted = await mountInMemory(module.fs, `/files/disassembly-${name}-${address}`, 'binary', file);
    const session = module.newSession();
    module.openSession(session, mounted.path);

    try {
        const rows = { fileId: 1, address, findRow: () => undefined };

        return (await disassembleFunction(module, session, rows, new AbortController().signal, maxBytes)).value?.text;
    } finally {
        module.freeSession(session);
        mounted.unmount();
    }
}

test('disassembly of a function above the size limit stops at the limit with a note', async () => {
    expect(await disassembleAt('shapes-x64.so', 0x1a40n, 8)).toBe([
        '; long rect_area(int width, int height)',
        '00001a40  push r15',
        '00001a42  push r14',
        '00001a44  push rbx',
        '; 97 bytes of code, of which the engine shows the first 5.',
        '',
    ].join('\n'));
}, 120000);

test('disassembly of big_sum, a function of 188,168 bytes, decodes every instruction of its long blocks without a cut', async () => {
    const { text } = await readDisassembly(await openFile('big-x64.so'), 'big_sum');
    const instructions = text.trimEnd().split('\n').slice(1);
    const addresses = instructions.map(line => parseInt(line.slice(0, 8), 16));

    expect(instructions.filter(line => !/^[0-9a-f]{8}  [a-z]/.test(line) || /\b(invalid|undefined)\b/.test(line))).toEqual([]);
    expect(addresses.at(-1)! - addresses[0]).toBeGreaterThan(188_000);
}, 120000);

test("32-bit ARM code disassembles, though the engine can't decompile it", async () => {
    const { text } = await readDisassembly(await openFile('extras-arm.so'), 'extras_name');

    expect(text).toContain('  add r0, pc, r0\n');
    expect(text).toContain('  bx lr\n');
}, 120000);

test("read refuses the disassembly of MIPS code, which the engine's disassembler doesn't read", async () => {
    const file = await openFile('extras-mips.so');

    await expect(file.engine.read(file.fileId, findKey(file, 'extras_name'), 'assembly')).rejects.toThrow(
        "The native engine can't disassemble MIPS code.",
    );
}, 120000);

test("a call in scale_twice shows extras::scale and points at its row, also in a file at a high image base", async () => {
    for (const name of ['extras-x64.so', 'extras-high.so']) {
        const file = await openFile(name);
        const { text, tokens } = await readDisassembly(file, 'scale_twice');
        const keys = file.rows.filter(row => row.name === 'scale').map(row => `${file.fileId}:${(row.key >>> 0).toString(16)}`);

        expect(text).toContain('  call extras::scale\n');
        expect(keys).toContain(findToken(text, tokens, 'extras::scale')?.target ?? '');
    }
}, 120000);

test("a call of an import's stub shows the import's name and points at its row, and keeps Rizin's name without a row", async () => {
    const file = await openFile('extras-x64.so');
    const { text, tokens } = await readDisassembly(file, 'calls_external');
    const arm = await readDisassembly(await openFile('extras-arm.so'), 'calls_external');

    expect(findToken(text, tokens, 'external_value')).toMatchObject({
        kind: 'method',
        flags: 0,
        target: `${file.fileId}:${(findKey(file, 'external_value') >>> 0).toString(16)}`,
    });
    expect(arm.text).toContain('  bl fcn.00010440\n');
}, 120000);

test("a canceled disassembly of big_sum stops after the chunk that the glue disassembles, inside the engine's cancel limit", async () => {
    const module = await loadTestModule();
    const controller = new AbortController();
    const counts = { chunks: 0 };
    let abortedAt = 0;
    const watched: NativeModule = {
        ...module,
        disassemble(session, address, size, maxBytes) {
            if (++counts.chunks === 2) {
                controller.abort();
                abortedAt = performance.now();
            }

            return module.disassemble(session, address, size, maxBytes);
        },
    };
    const handlers = createNativeHandlers(async () => watched, mountInMemory);
    const file = await readFixture('big-x64.so');
    const signal = new AbortController().signal;
    await handlers.open(1, file.name, file, signal);
    const bigSum = readRows((await handlers.list(1, signal)).value!).find(row => row.name === 'big_sum')!;

    await expect(handlers.read(1, bigSum.key, 'assembly', controller.signal)).rejects.toThrow();
    expect(counts.chunks).toBe(2);
    expect(performance.now() - abortedAt).toBeLessThan(2000);
}, 120000);

test("disassembly of Rect writes the struct and its static member as comment lines, then its methods' code", async () => {
    const file = await openFile('shapes-x64.so');
    const { text, tokens } = await readDisassembly(file, 'Rect');

    expect(text).toStartWith(
        '; struct Rect {\n;     int width_;\n;     int height_;\n; };\n; extern undefined4 geometry::Rect::count; // 0x3c68\n\n',
    );
    expect(text).toContain('\n; long geometry::Rect::area(const struct Rect *this, int scale)\n00001990  movsxd rax, dword [rdi]\n');
    expect(findToken(text, tokens, 'Rect')).toMatchObject({ kind: 'class', target: `${file.fileId}:${(findKey(file, 'Rect') >>> 0).toString(16)}` });
}, 120000);
