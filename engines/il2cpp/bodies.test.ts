import { findRow } from '#contract/checking';
import { type Document, formatTarget, parseTarget, readTokens } from '#contract/document';
import type { Engine } from '#contract/engine';
import { useInThreadWorker } from '#contract/in-thread-worker';
import { connectEngine } from '#contract/queue';
import { CanceledError, type Reply } from '#contract/reply';
import { readRows } from '#contract/rows';
import type { EngineHandlers } from '#contract/serve';
import { modifiersOf } from '#contract/symbols';
import { afterAll, expect, test } from 'bun:test';
import { mountInMemory } from '../native/files';
import { createNativeHandlers, type NativeHandlers } from '../native/handlers';
import { loadTestModule } from '../native/testing';
import { createIl2CppHandlers } from './handlers';
import manifest from './manifest.json' with { type: 'json' };
import { readBuildFile, realBuilds } from './real-builds';
import { readBinaryKey } from './rows';
import { CountedFile, loadTestRuntime, readFixture, useIl2CppEngine } from './testing';

const connect = useIl2CppEngine({ withNative: true });
await Promise.all([loadTestRuntime(), loadTestModule()]);

// reads a type's document until the engine wrote all of it, like the page does
async function readWhole(engine: Engine, fileId: number, key: number): Promise<Document> {
    for (;;) {
        const document = await engine.read(fileId, key, 'csharp');
        if (!document.isPartial) {
            return document;
        }
    }
}

// reads a type's document of file 1 until the handlers wrote all of it
async function readWholeReply(handlers: EngineHandlers, key: number): Promise<Reply<Document>> {
    for (;;) {
        const reply = await handlers.read(1, key, 'csharp', new AbortController().signal);
        if (!reply.value?.isPartial) {
            return reply;
        }
    }
}

// opens a game in handlers with the native engine, with a lookup of its rows by their paths
async function openHandlers(metadata: File, binary: File, createNative = () => createNativeHandlers(loadTestModule, mountInMemory)) {
    const handlers = createIl2CppHandlers(loadTestRuntime, createNative);
    const signal = new AbortController().signal;
    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, 'GameAssembly.dll', binary, signal);
    const rows = readRows((await handlers.list(1, signal)).value!);

    return { handlers, rows, rowOf: (path: string) => findRow(rows, path, metadata.name) };
}

let build2019: ReturnType<typeof openHandlers> | undefined;

// opens the 2019 build once for the first tests, which only read it, because its open with the native engine takes
// seconds. They come first because each new set of handlers resets the runtime's games.
async function open2019() {
    const build = realBuilds['2019.4.34'];
    build2019 ??= openHandlers(await readBuildFile(build.metadata), await readBuildFile(build.binary));

    return build2019;
}

afterAll(async () => (await build2019)?.handlers.close(1, new AbortController().signal));

async function openGame(engine: Engine, metadata: File, binary: File) {
    const fileId = await engine.open(metadata.name, metadata);
    await engine.provide(fileId, 'GameAssembly.dll', binary);
    const rows = readRows(await engine.list(fileId));

    return { fileId, rows, rowOf: (path: string) => findRow(rows, path, metadata.name) };
}

test("il2cpp engine fills a type's method bodies with the C of the native engine, without the addresses in the body", async () => {
    const { handlers, rowOf } = await open2019();
    const text = (await readWholeReply(handlers, rowOf('Assembly-CSharp.dll.NormalBehaviour').key)).value!.text;

    // `NormalBehaviour.Start` is empty, so its code at 0x14dae0 only returns, like the code of every other empty method
    expect(text).toMatch(/\tprivate void Start\(\)\n\t\{\n\t\t\/\/ Shares its code with [^\n]+ and \d+ more methods\.\n\t\treturn;\n\t\}\n/);
    expect(text).not.toMatch(/\{\n\t*\}/);
}, 300000);

test("a body's call of a function without a method links to the binary's own C of the function, which the engine reads", async () => {
    const { handlers, rowOf } = await open2019();
    const signal = new AbortController().signal;
    const document = (await readWholeReply(handlers, rowOf('UnityEngine.CoreModule.dll.UnityEngine.Vector3').key)).value!;
    const tokens = readTokens(document);

    // the first function of the binary that isn't a method of the game, like a function of the runtime
    const call = tokens.find(token => token.target !== null && readBinaryKey((parseTarget(token.target) as { key: number }).key) !== undefined)!;
    const { key } = parseTarget(call.target!) as { key: number };
    const name = document.text.slice(call.start, call.start + call.length);

    expect((await handlers.resolve(call.target!, signal)).value).toBe(call.target);
    expect((await handlers.read(1, key, 'c', signal)).value!.text).toContain(`${name}(`);
    expect((await handlers.read(1, key, 'csharp', signal)).error).toBe("The IL2CPP engine doesn't have the view csharp.");
}, 300000);

const versions = ['2019.4.34', '2022.3.35'] as const;

test.each(versions)("il2cpp engine writes the C of the %s build's methods in C#'s words where it knows the pattern", async version => {
    const build = realBuilds[version];
    const isShared = version === '2019.4.34';
    const game = await (isShared ? open2019() : openHandlers(await readBuildFile(build.metadata), await readBuildFile(build.binary)));
    const text = (await readWholeReply(game.handlers, game.rowOf('UnityEngine.CoreModule.dll.UnityEngine.Debug').key)).value!.text;

    // `Debug.get_unityLogger` only returns its static field once IL2CPP's checks go
    expect(text).toContain('\t\t\treturn Debug.s_Logger;\n');
    expect(text).not.toContain('il2cpp_runtime_class_init(UnityEngine.Debug_TypeInfo)');
    expect(text).not.toContain('(void *)0x0');
    if (!isShared) {
        await game.handlers.close(1, new AbortController().signal);
    }
}, 300000);

test("il2cpp engine gives the native engine the structs and globals that a type's bodies need, not those of the whole game", async () => {
    const build = realBuilds['2022.3.35'];
    let headerBytes = 0;
    const globalLines: Promise<number>[] = [];
    const countGlobals = async (lines?: Blob) => (((await lines?.text()) ?? '').match(/^@/gm) ?? []).length;
    const createCounted = () => {
        const native = createNativeHandlers(loadTestModule, mountInMemory);
        const { loadNames, loadTypes } = native;
        native.loadNames = (fileId, lines, header) => {
            headerBytes += header.size;
            globalLines.push(countGlobals(lines));

            return loadNames(fileId, lines, header);
        };
        native.loadTypes = (fileId, header, globals) => {
            headerBytes += header.size;
            globalLines.push(countGlobals(globals));

            return loadTypes(fileId, header, globals);
        };

        return native;
    };
    const game = await openHandlers(await readBuildFile(build.metadata), await readBuildFile(build.binary), createCounted);
    const text = (await readWholeReply(game.handlers, game.rowOf('UnityEngine.CoreModule.dll.UnityEngine.Debug').key)).value!.text;
    const globalCount = (await Promise.all(globalLines)).reduce((sum, count) => sum + count, 0);

    // the structs of the build's classes take about 1 MB, and the build has about 8,000 globals
    expect(headerBytes).toBeLessThan(100 * 1024);
    expect(globalCount).toBeLessThan(1000);
    expect(text).toContain('\t\t\treturn Debug.s_Logger;\n');
    await game.handlers.close(1, new AbortController().signal);
}, 300000);

test('a read of a type that the user leaves while the native engine works stops, and the next read gets every body', async () => {
    const engine = connect();
    const game = await openGame(engine, await readFixture('global-metadata.dat'), await readFixture('GameAssembly.dll'));
    const circle = game.rowOf('Assembly-CSharp.dll.Shapes.Circle');
    const controller = new AbortController();
    const canceled = engine.read(game.fileId, circle.key, 'csharp', controller.signal);
    setTimeout(() => controller.abort(), 50);

    await expect(canceled).rejects.toBeInstanceOf(CanceledError);
    const text = (await readWhole(engine, game.fileId, circle.key)).text;

    expect(text).toContain('\tpublic float Radius\n\t{\n\t\tget\n\t\t{\n\t\t\t');
    expect(text).not.toMatch(/\{\n\t*\}/);
}, 300000);

test("il2cpp engine reads the game's binary once for the game and its hash, and the native engine once to open it", async () => {
    const handlers = createIl2CppHandlers(loadTestRuntime, () => createNativeHandlers(loadTestModule, mountInMemory));
    const signal = new AbortController().signal;
    const metadata = await readFixture('global-metadata.dat');
    const binary = new CountedFile([await (await readFixture('GameAssembly.dll')).bytes()], 'GameAssembly.dll');

    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, binary.name, binary, signal);
    const readsToProvide = binary.reads;
    const circle = readRows((await handlers.list(1, signal)).value!).find(row => row.name === 'Circle')!;
    const stub = await readWholeReply(handlers, circle.key);

    expect(readsToProvide).toBe(1);
    expect(binary.reads).toBe(2);
    expect(stub.value!.text).toContain('\t\tget\n\t\t{\n\t\t\t');
    await handlers.close(1, signal);
}, 300000);

test("il2cpp engine fills the body of a method that the native engine's listing leaves out", async () => {
    // lists 1 function, like the binary of a game with more functions than the native engine lists
    async function loadCapped() {
        const module = await loadTestModule();

        return { ...module, listSymbols: (session: number) => module.listSymbols(session, 1) };
    }
    const handlers = createIl2CppHandlers(loadTestRuntime, () => createNativeHandlers(loadCapped, mountInMemory));
    const signal = new AbortController().signal;
    const metadata = await readFixture('global-metadata.dat');

    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, 'GameAssembly.dll', await readFixture('GameAssembly.dll'), signal);
    const circle = readRows((await handlers.list(1, signal)).value!).find(row => row.name === 'Circle')!;
    const stub = await readWholeReply(handlers, circle.key);

    expect(stub.value!.text).not.toMatch(/\{\n\t*\}/);
    await handlers.close(1, signal);
}, 300000);

test("il2cpp engine's first read with bodies doesn't list the binary's functions in the native engine", async () => {
    let listings = 0;
    async function loadCounted() {
        const module = await loadTestModule();

        return { ...module, listSymbols: (session: number, maxMembers: number) => (listings++, module.listSymbols(session, maxMembers)) };
    }
    const handlers = createIl2CppHandlers(loadTestRuntime, () => createNativeHandlers(loadCounted, mountInMemory));
    const signal = new AbortController().signal;
    const metadata = await readFixture('global-metadata.dat');

    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, 'GameAssembly.dll', await readFixture('GameAssembly.dll'), signal);
    const circle = readRows((await handlers.list(1, signal)).value!).find(row => row.name === 'Circle')!;
    const stub = await readWholeReply(handlers, circle.key);

    expect(stub.value!.text).toContain('return (int)this * 3 + 8;');
    expect(listings).toBe(0);
    await handlers.close(1, signal);
}, 300000);

test("C bodies keep the native engine's tokens, and a called method's token goes to the method's row", async () => {
    const engine = connect();
    const metadata = await readFixture('global-metadata.dat');
    // reads the stub before the binary too, like the page does when it opens a type while the binary comes
    const fileId = await engine.open(metadata.name, metadata);
    const player = findRow(readRows(await engine.list(fileId)), 'Assembly-CSharp.dll.Player', metadata.name);
    await readWhole(engine, fileId, player.key);
    await engine.provide(fileId, 'GameAssembly.dll', await readFixture('GameAssembly.dll'));
    const rows = readRows(await engine.list(fileId));
    const game = { fileId, rows, rowOf: (path: string) => findRow(rows, path, metadata.name) };
    const document = await readWhole(engine, fileId, game.rowOf('Assembly-CSharp.dll.Player').key);
    const tokens = readTokens(document);
    const keys = new Set(rows.map(row => row.key));

    // `Player.Update` calls `Shapes.Circle.Area`
    const call = tokens.find(token => document.text.slice(token.start, token.start + token.length) === 'Area');
    const area = game.rowOf('Assembly-CSharp.dll.Shapes.Circle.Area()');
    expect(call?.target).toBe(formatTarget({ fileId: game.fileId, key: area.key }));
    // moves the stub's own tokens past the C above them, like the declaration of `Update` after the body of `Start`
    const update = formatTarget({ fileId: game.fileId, key: game.rowOf('Assembly-CSharp.dll.Player.Update()').key });
    const updateName = tokens.find(token => token.target === update && modifiersOf(token.flags).includes('declaration'));
    expect(document.text.slice(updateName!.start, updateName!.start + updateName!.length)).toBe('Update');
    // leaves out the targets of the native engine's rows, whose keys the il2cpp engine's rows don't share
    expect(tokens.every(({ target }) => {
        const parsed = target === null ? undefined : parseTarget(target);

        return parsed === undefined || !('key' in parsed) || keys.has(parsed.key);
    })).toBe(true);
}, 300000);

test("il2cpp engine writes a call of the game's method in a C body as a C# call without the MethodInfo argument", async () => {
    const engine = connect();
    const game = await openGame(engine, await readFixture('global-metadata.dat'), await readFixture('GameAssembly.dll'));
    const document = await readWhole(engine, game.fileId, game.rowOf('Assembly-CSharp.dll.Player').key);
    const call = readTokens(document).find(token => document.text.slice(token.start, token.start + token.length) === 'Area');

    expect(document.text).toContain('this.Area();');
    expect(call?.target).toBe(formatTarget({ fileId: game.fileId, key: game.rowOf('Assembly-CSharp.dll.Shapes.Circle.Area()').key }));
}, 300000);

test("il2cpp engine fills the bodies of an armv7 libil2cpp.so's Thumb methods and points their calls at the methods", async () => {
    const engine = connect();
    const metadata = await readFixture('global-metadata.dat');
    const fileId = await engine.open(metadata.name, metadata);
    await engine.provide(fileId, 'libil2cpp.so', await readFixture('libil2cpp-armv7.so'));
    const rows = readRows(await engine.list(fileId));
    const document = await readWhole(engine, fileId, findRow(rows, 'Assembly-CSharp.dll.Player', metadata.name).key);
    const call = readTokens(document).find(token => document.text.slice(token.start, token.start + token.length) === 'Area');

    expect(document.text).not.toMatch(/\{\n\t*\}/);
    expect(call?.target).toBe(formatTarget({ fileId, key: findRow(rows, 'Assembly-CSharp.dll.Shapes.Circle.Area()', metadata.name).key }));
}, 300000);

// creates native handlers that note the address of the code of each decompile, which waits a while first
function createCountedNative(rvas: number[], delayMs = 0): () => NativeHandlers {
    return () => {
        const native = createNativeHandlers(loadTestModule, mountInMemory);

        return {
            ...native,
            async readCode(fileId, rva, signal) {
                rvas.push(rva);
                await Bun.sleep(delayMs);

                return native.readCode(fileId, rva, signal);
            },
        };
    };
}

// lists the addresses of the methods with code, each once, from the methods' rows
function listCodeAddresses(rows: { kind: string; detail: string }[]): Set<number> {
    return new Set(rows.filter(row => row.kind === 'method' && /^0x[0-9a-f]+$/.test(row.detail)).map(row => Number(row.detail)));
}

test("il2cpp engine decompiles Assembly-CSharp's methods in the background after it gets the binary, without the framework's", async () => {
    const keys: number[] = [];
    const handlers = createIl2CppHandlers(loadTestRuntime, createCountedNative(keys));
    const signal = new AbortController().signal;
    const metadata = await readFixture('global-metadata.dat');

    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, 'GameAssembly.dll', await readFixture('GameAssembly.dll'), signal);
    const rows = readRows((await handlers.list(1, signal)).value!);
    const assembly = rows.findIndex(row => row.name === 'Assembly-CSharp.dll');
    const isInAssembly = (index: number): boolean => index === assembly || (index >= 0 && isInAssembly(rows[index].parent));
    // waits for the decompiles of the methods of Assembly-CSharp, which the background takes
    const expected = listCodeAddresses(rows.filter(row => isInAssembly(row.parent))).size;
    while (keys.length < expected) {
        await Bun.sleep(50);
    }
    await Bun.sleep(200);
    const readCount = keys.length;
    const stub = await readWholeReply(handlers, rows.find(row => row.name === 'Circle')!.key);
    const objectConstructor = Number(findRow(rows, 'mscorlib.dll.System.Object.Object()', metadata.name).detail);

    expect(readCount).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(readCount);
    expect(keys).not.toContain(objectConstructor);
    expect(stub.value!.text).toContain('\t\tget\n\t\t{\n\t\t\t');
    await handlers.close(1, signal);
}, 300000);

test("a type's read decompiles the type's methods ahead of the methods that wait in the background", async () => {
    const keys: number[] = [];
    const handlers = createIl2CppHandlers(loadTestRuntime, createCountedNative(keys));
    const signal = new AbortController().signal;
    const build = realBuilds['2019.4.34'];
    const metadata = await readBuildFile(build.metadata);

    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, 'GameAssembly.dll', await readBuildFile(build.binary), signal);
    const rows = readRows((await handlers.list(1, signal)).value!);
    const normal = rows.find(row => row.name === 'NormalBehaviour')!;
    await readWholeReply(handlers, normal.key);

    // the addresses of `NormalBehaviour.Start` and its constructor, whose type comes after thousands of methods
    expect(keys.indexOf(0x14dae0)).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf(0x14dae0)).toBeLessThan(20);
    expect(keys.indexOf(0x14da10)).toBeLessThan(20);
    expect(keys.length).toBeLessThan(listCodeAddresses(rows).size / 2);
    await handlers.close(1, signal);
}, 300000);

test("a read replies with the bodies that came in half a second and the page's next reads get the rest", async () => {
    const handlers = createIl2CppHandlers(loadTestRuntime, createCountedNative([], 300));
    const signal = new AbortController().signal;
    const metadata = await readFixture('global-metadata.dat');
    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, 'GameAssembly.dll', await readFixture('GameAssembly.dll'), signal);
    const circle = readRows((await handlers.list(1, signal)).value!).find(row => row.name === 'Circle')!;

    const first = await handlers.read(1, circle.key, 'csharp', signal);
    const whole = await readWholeReply(handlers, circle.key);

    expect(first.value!.isPartial).toBe(true);
    expect(first.value!.text).toContain('\t\t\t// The native engine is still decompiling this method…\n');
    expect(whole.value!.text).not.toContain('still decompiling');
    await handlers.close(1, signal);
}, 300000);

test("a type's read goes ahead of the decompiles that a stopped read of another type left", async () => {
    const rvas: number[] = [];
    const handlers = createIl2CppHandlers(loadTestRuntime, createCountedNative(rvas, 100));
    const signal = new AbortController().signal;
    const metadata = await readFixture('global-metadata.dat');
    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, 'GameAssembly.dll', await readFixture('GameAssembly.dll'), signal);
    const rows = readRows((await handlers.list(1, signal)).value!);
    const circle = rows.find(row => row.name === 'Circle')!;
    const circleCode = listCodeAddresses(rows.filter(row => row.parent === rows.indexOf(circle)));

    const controller = new AbortController();
    const stopped = handlers.read(1, circle.key, 'csharp', controller.signal);
    setTimeout(() => controller.abort(), 150);
    await Promise.resolve(stopped).catch(() => undefined);
    await readWholeReply(handlers, rows.find(row => row.name === 'Player')!.key);

    expect(rvas.filter(rva => circleCode.has(rva)).length).toBeLessThan(circleCode.size);
    await handlers.close(1, signal);
}, 300000);

test("a hover's describe gets its reply while a type's read waits for the native engine's decompiles", async () => {
    useInThreadWorker(() => createIl2CppHandlers(loadTestRuntime, createCountedNative([], 300)));
    const engine = connectEngine('engine.js', { timeLimitMs: 120000, cancelLimitMs: 30000, repliesDuringReads: manifest.repliesDuringReads });
    const game = await openGame(engine, await readFixture('global-metadata.dat'), await readFixture('GameAssembly.dll'));
    const order: string[] = [];

    const read = readWhole(engine, game.fileId, game.rowOf('Assembly-CSharp.dll.Shapes.Circle').key).then(() => order.push('read'));
    await Bun.sleep(100);
    const area = formatTarget({ fileId: game.fileId, key: game.rowOf('Assembly-CSharp.dll.Shapes.Circle.Area()').key });
    const described = engine.describe(area, 'csharp').then(() => order.push('describe'));
    await Promise.all([read, described]);

    expect(order).toEqual(['describe', 'read']);
    await engine.close(game.fileId);
}, 300000);
