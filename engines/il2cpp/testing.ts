import { findRow } from '#contract/checking';
import type { Document } from '#contract/document';
import type { Engine } from '#contract/engine';
import { connectEngine } from '#contract/queue';
import { readRows } from '#contract/rows';
import type { EngineHandlers } from '#contract/serve';
import { afterEach, beforeAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frameworkFolder, publishEngine } from '../dotnet/build';
import { mountInMemory } from '../native/files';
import { createNativeHandlers } from '../native/handlers';
import { loadTestModule } from '../native/testing';
import { useEngine } from '../shared/testing';
import { buildFixture, buildFixtureInto } from './fixture/build';
import { codeImages } from './fixture/code-game';
import { fixtureLayouts } from './fixture/metadata';
import { fieldAttributes, type FixtureType, images, methodAttributes, typeAttributes } from './fixture/model';
import type { Game } from './game';
import { readGameReply } from './game-reader';
import { createIl2CppHandlers } from './handlers';
import { writeNativeNames } from './names-file';
import { type Il2CppRuntime, loadRuntime } from './runtime';

let runtimeLoad: Promise<Il2CppRuntime> | undefined;
let runtime: Il2CppRuntime | undefined;

const connectOptions = { timeLimitMs: 120000, cancelLimitMs: 30000 };

/** Reads a file of the fixture, like `global-metadata.dat`, and builds the fixture first when its folder is missing. */
export async function readFixture(name: string): Promise<File> {
    return new File([await Bun.file(join(buildFixture(), name)).bytes()], name);
}

const otherGameFolder = fileURLToPath(new URL('../../artifacts/il2cpp-test/other-game/', import.meta.url));

/** Reads a file of another game's build, whose `Assembly-CSharp.dll` has 1 more type than the fixture's. */
export async function readOtherGame(name: string): Promise<File> {
    if (!existsSync(join(otherGameFolder, name))) {
        const [corlib, game] = images;
        const extra = { ...game.types[game.types.length - 1], name: 'Enemy' };
        buildFixtureInto(otherGameFolder, [corlib, { ...game, types: [...game.types, extra] }]);
    }

    return new File([await Bun.file(join(otherGameFolder, name)).bytes()], name);
}

const olderLayoutFolder = fileURLToPath(new URL('../../artifacts/il2cpp-test/layout-29.0/', import.meta.url));

/** Reads a file of the fixture's build in the version 29.0 layout, which LibCpp2IL doesn't read as the newer 29.1. */
export async function readOlderLayout(name: string): Promise<File> {
    if (!existsSync(join(olderLayoutFolder, name))) {
        buildFixtureInto(olderLayoutFolder, images, fixtureLayouts['29.0']);
    }

    return new File([await Bun.file(join(olderLayoutFolder, name)).bytes()], name);
}

const constantGameFolder = fileURLToPath(new URL('../../artifacts/il2cpp-test/constant-game/', import.meta.url));

/**
 * Reads a file of another game's build, whose `Player` has the string constant `Greeting` with a line break, a tab, a
 * control character and a quote.
 */
export async function readConstantGame(name: string): Promise<File> {
    if (!existsSync(join(constantGameFolder, name))) {
        const [corlib, game] = images;
        const flags = fieldAttributes.public | fieldAttributes.static | fieldAttributes.literal | fieldAttributes.hasDefault;
        const greeting = { name: 'Greeting', type: 'System.String', flags, value: 'Hi\nthere\t\u0001"' };
        const player = { ...game.types[game.types.length - 1], fields: [greeting] };
        buildFixtureInto(constantGameFolder, [corlib, { ...game, types: [...game.types.slice(0, -1), player] }]);
    }

    return new File([await Bun.file(join(constantGameFolder, name)).bytes()], name);
}

const cyclicGameFolder = fileURLToPath(new URL('../../artifacts/il2cpp-test/cyclic-game/', import.meta.url));

/**
 * Reads a file of a crafted game, whose `Loop.A` is nested in `Loop.B` and `Loop.B` in `Loop.A`, and whose `Player`
 * has a field of the type `Loop.A`.
 */
export async function readCyclicGame(name: string): Promise<File> {
    if (!existsSync(join(cyclicGameFolder, name))) {
        const [corlib, game] = images;
        const player = game.types[game.types.length - 1];
        const loop = (own: string, outer: string): FixtureType => {
            return { ...player, namespace: 'Loop', name: own, declaringType: `Loop.${outer}`, fields: [], methods: [], properties: [] };
        };
        const field = { name: 'loop', type: 'Loop.A', flags: fieldAttributes.public };
        const types = [...game.types.slice(0, -1), { ...player, fields: [field] }, loop('A', 'B'), loop('B', 'A')];
        buildFixtureInto(cyclicGameFolder, [corlib, { ...game, types }]);
    }

    return new File([await Bun.file(join(cyclicGameFolder, name)).bytes()], name);
}

const bigGameFolder = fileURLToPath(new URL('../../artifacts/il2cpp-test/big-game/', import.meta.url));

/**
 * Reads a file of a game with 20,000 classes of 3 fields and 5 methods each, about the size of a real game's
 * `Assembly-CSharp.dll`. Only the first method of the first 500 classes has code, because clang would compile 100,000
 * functions for minutes.
 */
export async function readBigGame(name: string): Promise<File> {
    if (!existsSync(join(bigGameFolder, name))) {
        const types: FixtureType[] = Array.from({ length: 20000 }, (_, index) => ({
            namespace: `Big.Space${index % 50}`,
            name: `Class${index}`,
            kind: 'class',
            flags: typeAttributes.public,
            base: 'System.Object',
            interfaces: [],
            declaringType: null,
            fields: [0, 1, 2].map(field => ({ name: `field${field}`, type: 'System.Int32', flags: fieldAttributes.public })),
            methods: [0, 1, 2, 3, 4].map(method => ({
                name: `Method${method}`,
                returnType: 'System.Int32',
                parameters: [{ name: 'value', type: 'System.Int32' }],
                flags: methodAttributes.public | methodAttributes.hideBySig,
                hasBody: index < 500 && method === 0,
            })),
            properties: [],
        }));
        buildFixtureInto(bigGameFolder, [images[0], { name: 'Assembly-CSharp.dll', types }]);
    }

    return new File([await Bun.file(join(bigGameFolder, name)).bytes()], name);
}

const codeGameFolder = fileURLToPath(new URL('../../artifacts/il2cpp-test/code-game/', import.meta.url));

/** Reads a file of the game of `codeImages`, whose methods have code like IL2CPP's, or its linker's map. */
export async function readCodeGame(name: string): Promise<File> {
    // builds again after a change of the game, whose folder doesn't have the fixture's hash in its name
    const stamp = join(codeGameFolder, 'images.json');
    const written = JSON.stringify(codeImages);
    if (!existsSync(stamp) || (await Bun.file(stamp).text()) !== written) {
        buildFixtureInto(codeGameFolder, codeImages);
        await Bun.write(stamp, written);
    }

    return new File([await Bun.file(join(codeGameFolder, name)).bytes()], name);
}

/**
 * Opens the game of `codeImages` with its Windows binary, or with another of its binaries, in handlers with the native
 * engine, or with the native handlers of `createNative`, as file 1. Returns the handlers and a read of the document of a type of the game's scripts, which reads
 * until the engine wrote all of the document, like the page does.
 */
export async function openCodeGame(binaryName = 'GameAssembly.dll', createNative = () => createNativeHandlers(loadTestModule, mountInMemory)) {
    const signal = new AbortController().signal;
    const handlers = createIl2CppHandlers(loadTestRuntime, createNative);
    const metadata = await readCodeGame('global-metadata.dat');
    await handlers.open(1, metadata.name, metadata, signal);
    await handlers.provide(1, binaryName, await readCodeGame(binaryName), signal);
    const rows = readRows((await handlers.list(1, signal)).value!);

    async function readType(name: string): Promise<Document> {
        const { key } = findRow(rows, `Assembly-CSharp.dll.${name}`, metadata.name);
        for (;;) {
            const reply = await handlers.read(1, key, 'csharp', signal);
            if (!reply.value?.isPartial) {
                return reply.value!;
            }
        }
    }

    return { handlers, rows, readType, close: () => handlers.close(1, signal) };
}

/**
 * Opens a game's binary in native handlers as file 1, with the names that the IL2CPP engine writes for it. Returns the
 * game, its names and a read of the native engine's code of a method, with the structs and globals that the code
 * needs, like a body's read.
 */
export async function openNativeGame(metadata: File, binary: File) {
    const [runtime] = await Promise.all([loadTestRuntime(), loadTestModule()]);
    const signal = new AbortController().signal;
    const game = readGame(runtime, await metadata.bytes(), await binary.bytes(), binary.name);
    // clears bit 0 of a method's address in a 32-bit binary, which marks Thumb code in the fixture's armv7 build
    const findCode = (rva: number) => (game.pointerSize === 4 ? rva - (rva & 1) : rva);
    const native = createNativeHandlers(loadTestModule, mountInMemory);
    const names = writeNativeNames(game, findCode);
    await native.open(1, binary.name, binary, signal);
    await native.loadNames(1, names.lines, new Blob());

    async function readMethod(typeName: string, methodName: string, isCSharp = false): Promise<string> {
        const methods = game.types.flatMap(type => (type.name === typeName ? type.methods : []));
        const code = findCode(methods.find(method => method.name === methodName)!.rva!);
        const targets = await native.listCodeTargets(1, code);
        const types = names.writeTypes([code, ...targets.value!]);
        await native.loadTypes(1, new Blob([types.header]), new Blob([types.globals]));

        return (await native.readCode(1, code, signal, isCSharp)).value!.text;
    }

    return { game, names, readMethod, close: () => native.close(1, signal) };
}

/** Cuts a member's lines out of a type's document, from its header to the line before the `}` of its body. */
export function cutMember(text: string, header: string): string {
    const start = text.indexOf(header);
    const indentation = text.slice(text.lastIndexOf('\n', start) + 1, start);

    return text.slice(start, text.indexOf(`\n${indentation}}`, start));
}

const wideGameFolder = fileURLToPath(new URL('../../artifacts/il2cpp-test/wide-game/', import.meta.url));

/** Reads a file of a game whose 1 class has 5,000 fields, like the generated tables of a real game's scripts. */
export async function readWideGame(name: string): Promise<File> {
    if (!existsSync(join(wideGameFolder, name))) {
        const wide: FixtureType = {
            namespace: 'Wide',
            name: 'Table',
            kind: 'class',
            flags: typeAttributes.public,
            base: 'System.Object',
            interfaces: [],
            declaringType: null,
            fields: Array.from({ length: 5000 }, (_, field) => ({ name: `field${field}`, type: 'System.Int32', flags: fieldAttributes.public })),
            methods: [],
            properties: [],
        };
        buildFixtureInto(wideGameFolder, [images[0], { name: 'Assembly-CSharp.dll', types: [wide] }]);
    }

    return new File([await Bun.file(join(wideGameFolder, name)).bytes()], name);
}

async function publishAndLoad(): Promise<Il2CppRuntime> {
    await publishEngine();
    runtime = await loadRuntime(pathToFileURL(`${frameworkFolder}/dotnet.js`).href);

    return runtime;
}

/** A file that counts the reads of its bytes, for tests of how often the engines read a game's binary. */
export class CountedFile extends File {
    reads = 0;

    override bytes(): Promise<Uint8Array<ArrayBuffer>> {
        this.reads++;

        return super.bytes();
    }
}

/** Reads a game from its metadata and binary with the runtime under the file id 0, like `open` and `provide` do. */
export function readGame(runtime: Il2CppRuntime, metadata: Uint8Array, binary: Uint8Array, binaryName = 'GameAssembly.dll'): Game {
    runtime.exports.ReadMetadata(0, 'global-metadata.dat', metadata);

    return readGameReply(runtime.exports.ReadGame(0, 'global-metadata.dat', binaryName, binary)).value!;
}

/** Publishes the .NET engine when its stamp is stale and loads its published runtime, once in a process. */
export function loadTestRuntime(): Promise<Il2CppRuntime> {
    runtimeLoad ??= publishAndLoad();

    return runtimeLoad;
}

/**
 * Serves the IL2CPP engine in an in-thread worker during each test of a file and returns the function that connects
 * a test. The engine fills the methods' bodies with the C of the native engine's module when `withNative` is set.
 */
export function useIl2CppEngine({ withNative = false } = {}): () => Engine {
    // publishes before the file's first test because a publish on a fresh checkout takes longer than a test's 5 seconds
    beforeAll(loadTestRuntime, connectOptions.timeLimitMs);

    const createNative = withNative ? () => createNativeHandlers(loadTestModule, mountInMemory) : undefined;
    // closes the files that a test leaves open, because their decompiles in the background would outlast the test
    let closes: (() => Promise<unknown>)[] = [];
    afterEach(async () => {
        await Promise.all(closes.map(close => close()));
        closes = [];
    });

    function create(): EngineHandlers {
        const handlers = createIl2CppHandlers(loadTestRuntime, createNative);

        return {
            ...handlers,
            open(fileId, ...rest) {
                closes.push(async () => handlers.close(fileId, new AbortController().signal));

                return handlers.open(fileId, ...rest);
            },
        };
    }

    return useEngine(create, connectOptions, () => runtime?.readMemoryBytes() ?? 0);
}

/** Connects a test to the IL2CPP engine in the in-thread worker that the test serves. */
export function connectIl2Cpp(): Engine {
    return connectEngine('il2cpp.js', connectOptions);
}
