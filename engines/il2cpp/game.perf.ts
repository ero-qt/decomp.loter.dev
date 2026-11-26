import { readRows } from '#contract/rows';
import { expect, test } from 'bun:test';
import { mountInMemory } from '../native/files';
import { createNativeHandlers } from '../native/handlers';
import { loadTestModule } from '../native/testing';
import type { GameType } from './game';
import { createIl2CppHandlers } from './handlers';
import { listRows } from './rows';
import { loadTestRuntime, readBigGame, readWideGame } from './testing';

const [runtime] = await Promise.all([loadTestRuntime(), loadTestModule()]);
const metadata = await readBigGame('global-metadata.dat');
const binary = await readBigGame('GameAssembly.dll');
const signal = new AbortController().signal;

test('il2cpp engine opens a game of 20,000 classes and 100,000 methods with its binary in less than 250 MB of wasm memory', async () => {
    const handlers = createIl2CppHandlers(async () => runtime);

    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, binary.name, binary, signal);
    const listing = await handlers.list(1, signal);

    expect(listing.value?.note).toBe('metadata 31.1, guessed among the layouts of version 31');
    expect(runtime.readMemoryBytes()).toBeLessThan(250 * 1024 * 1024);
}, 120000);

test("il2cpp engine shows a big game's first type in 5 seconds, with its C in 10 seconds and another type's C in 2", async () => {
    const handlers = createIl2CppHandlers(async () => runtime, () => createNativeHandlers(loadTestModule, mountInMemory));
    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, binary.name, binary, signal);
    const rows = readRows((await handlers.list(1, signal)).value!);
    const readWhole = async (name: string) => {
        const key = rows.find(row => row.name === name)!.key;
        for (let reply = await handlers.read(1, key, 'csharp', signal); ; reply = await handlers.read(1, key, 'csharp', signal)) {
            if (!reply.value!.isPartial) {
                return reply.value!;
            }
        }
    };

    const started = performance.now();
    const stub = await handlers.read(1, rows.find(row => row.name === 'Class0')!.key, 'csharp', signal);
    const stubMs = performance.now() - started;
    const first = await readWhole('Class0');
    const firstMs = performance.now() - started;
    const other = performance.now();
    const goneTo = await readWhole('Class7');
    const otherMs = performance.now() - other;
    console.log(JSON.stringify({ stubMs: Math.round(stubMs), firstMs: Math.round(firstMs), otherMs: Math.round(otherMs) }));

    expect(stub.value!.text).toContain('public int Method0(int value)');
    expect(first.text).toContain('return');
    expect(goneTo.text).toContain('return');
    expect(stubMs).toBeLessThan(5000);
    expect(firstMs).toBeLessThan(10000);
    expect(otherMs).toBeLessThan(2000);
    await handlers.close(1, signal);
}, 120000);

test('il2cpp engine reads the binary of a game whose class has 5,000 fields in less than 2 seconds', async () => {
    const handlers = createIl2CppHandlers(async () => runtime);
    const wideMetadata = await readWideGame('global-metadata.dat');
    const wideBinary = await readWideGame('GameAssembly.dll');
    await handlers.open(1, wideMetadata.name, wideMetadata, signal);

    const started = performance.now();
    const provided = await handlers.provide(1, wideBinary.name, wideBinary, signal);

    expect(provided.error).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2000);
    await handlers.close(1, signal);
}, 120000);

test('listRows lists a game with 100,000 types, each in its own namespace, in less than 5 seconds', () => {
    const types: GameType[] = Array.from({ length: 100_000 }, (_, index) => ({
        namespace: `N${index}`,
        name: `T${index}`,
        declaringType: -1,
        flags: 1,
        isValueType: false,
        isEnum: false,
        genericParameters: [],
        baseType: null,
        fields: [],
        methods: [],
        properties: [],
    }));
    const images = [{ name: 'Big.dll', firstType: 0, typeCount: types.length }];
    const game = {
        fileVersion: 31,
        layout: '31.1',
        isLayoutGuessed: false,
        unityVersion: '',
        pointerSize: 8,
        images,
        types,
        strings: [],
        globals: [],
        classes: [],
    };

    const started = performance.now();
    const rows = listRows(game);

    expect(performance.now() - started).toBeLessThan(5000);
    expect(rows).toHaveLength(1 + 2 * types.length);
});
