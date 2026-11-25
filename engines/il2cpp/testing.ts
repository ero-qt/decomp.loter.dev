import type { Engine } from '#contract/engine';
import { connectEngine } from '#contract/queue';
import { beforeAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frameworkFolder, publishEngine } from '../dotnet/build';
import { useEngine } from '../shared/testing';
import { buildFixture, buildFixtureInto } from './fixture/build';
import { fixtureLayouts } from './fixture/metadata';
import { fieldAttributes, type FixtureType, images, methodAttributes, typeAttributes } from './fixture/model';
import type { Game } from './game';
import { readGameReply } from './game-reader';
import { createIl2CppHandlers } from './handlers';
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

/** Serves the IL2CPP engine in an in-thread worker during each test of a file and returns the function that connects a test. */
export function useIl2CppEngine(): () => Engine {
    // publishes before the file's first test because a publish on a fresh checkout takes longer than a test's 5 seconds
    beforeAll(loadTestRuntime, connectOptions.timeLimitMs);

    return useEngine(() => createIl2CppHandlers(loadTestRuntime), connectOptions, () => runtime?.readMemoryBytes() ?? 0);
}

/** Connects a test to the IL2CPP engine in the in-thread worker that the test serves. */
export function connectIl2Cpp(): Engine {
    return connectEngine('il2cpp.js', connectOptions);
}
