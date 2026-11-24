import { findRow } from '#contract/checking';
import { formatTarget } from '#contract/document';
import type { Engine } from '#contract/engine';
import { readRows } from '#contract/rows';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildFixture } from '../il2cpp/fixture/build';
import { type BinaryIdentity, readBinaryIdentity } from '../shared/binary-identity';
import { readNamesFile } from './names-file';
import { loadTestModule, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

const gameFolder = buildFixture();
const binary = new File([await Bun.file(join(gameFolder, 'GameAssembly.dll')).bytes()], 'GameAssembly.dll');
// the image base of a 64-bit DLL that lld-link writes, which the map's addresses include
const imageBase = 0x180000000;

// reads a function's address relative to the image from the linker's map, like `Player__Update`
async function readRva(functionName: string): Promise<number> {
    const map = await Bun.file(join(gameFolder, 'GameAssembly.map')).text();
    const line = map.split('\n').find(found => found.trim().split(/\s+/)[1] === functionName);
    if (!line) {
        throw new Error(`the map doesn't have ${functionName}`);
    }

    return Number.parseInt(line.trim().split(/\s+/)[2], 16) - imageBase;
}

// writes a names file in Il2CppDumper's script.json shape, with each address relative to the image
function writeNamesFile(methods: [address: number, name: string][], binary?: BinaryIdentity): File {
    const scriptMethods = methods.map(([address, name]) => ({ Address: address, Name: name, Signature: '' }));

    return new File([JSON.stringify({ Binary: binary, ScriptMethod: scriptMethods })], 'script.json');
}


async function openBinary(): Promise<{ engine: Engine; fileId: number }> {
    const engine = connect();

    return { engine, fileId: await engine.open(binary.name, binary) };
}

test("il2cpp binary lists the game's metadata to open and script.json as a missing companion until provide gets script.json", async () => {
    const { engine, fileId } = await openBinary();
    const names = writeNamesFile([[await readRva('Player__Update'), 'Player$$Update']]);

    expect((await engine.list(fileId)).missingFiles).toEqual([
        { name: 'global-metadata.dat', reason: 'IL2CPP metadata, not loaded', isCompanion: false },
        { name: 'script.json', reason: 'IL2CPP names, not loaded', isCompanion: true },
    ]);

    await engine.provide(fileId, 'script.json', names);
    expect((await engine.list(fileId)).missingFiles).toEqual([]);
}, 120000);

test("names file lists the functions at its addresses, and a caller's C and assembly call the callee by its name", async () => {
    const { engine, fileId } = await openBinary();
    const names = writeNamesFile([
        [await readRva('Player__Update'), 'Player$$Update'],
        [await readRva('Shapes_Circle__Area'), 'Shapes.Circle$$Area'],
    ]);

    await engine.provide(fileId, 'script.json', names);
    const rows = readRows(await engine.list(fileId));
    const update = findRow(rows, 'Player$$Update', binary.name);

    expect((await engine.read(fileId, update.key, 'c')).text).toContain('Shapes.Circle$$Area(');
    expect((await engine.read(fileId, update.key, 'assembly')).text).toContain('  call Shapes.Circle$$Area\n');
}, 120000);

test("a caller's C keeps the call of a callee with a long name on one line", async () => {
    const { engine, fileId } = await openBinary();
    const longName = `Shapes.Circle$$${'Area'.repeat(40)}`;
    const names = writeNamesFile([
        [await readRva('Player__Update'), 'Player$$Update'],
        [await readRva('Shapes_Circle__Area'), longName],
    ]);

    await engine.provide(fileId, 'script.json', names);
    const update = findRow(readRows(await engine.list(fileId)), 'Player$$Update', binary.name);
    const lines = (await engine.read(fileId, update.key, 'c')).text.split('\n');

    expect(lines.find(line => line.includes(longName))).toMatch(/\(.*\);$/);
}, 120000);

test("provide refuses a names file whose addresses aren't in the binary's code, text that isn't a names file and the game's metadata", async () => {
    const { engine, fileId } = await openBinary();
    const other = writeNamesFile([[0x7fff0000, 'Other$$Method']]);
    const text = new File(['not json'], 'script.json');

    await expect(engine.provide(fileId, 'script.json', other)).rejects.toThrow("script.json doesn't match GameAssembly.dll.");
    await expect(engine.provide(fileId, 'script.json', text)).rejects.toThrow("script.json isn't a names file in Il2CppDumper's script.json shape.");
    await expect(engine.provide(fileId, 'global-metadata.dat', text)).rejects.toThrow("GameAssembly.dll doesn't need global-metadata.dat.");
    expect((await engine.list(fileId)).missingFiles.map(missingFile => missingFile.name)).toEqual(['global-metadata.dat', 'script.json']);
}, 120000);

test('provide refuses a names file of another binary and takes the names file of this binary', async () => {
    const { engine, fileId } = await openBinary();
    const bytes = await binary.bytes();
    const methods: [number, string][] = [[await readRva('Player__Update'), 'Player$$Update']];
    const other = writeNamesFile(methods, await readBinaryIdentity(new Blob([bytes.with(0, bytes[0] ^ 1)])));
    const own = writeNamesFile(methods, await readBinaryIdentity(binary));

    await expect(engine.provide(fileId, 'script.json', other)).rejects.toThrow(
        'script.json lists the functions of another binary, not of GameAssembly.dll.',
    );
    await engine.provide(fileId, 'script.json', own);
    expect(findRow(readRows(await engine.list(fileId)), 'Player$$Update', binary.name).name).toBe('Player$$Update');
}, 120000);

test('readNamesFile refuses a names file above 256 MB before it reads the text', async () => {
    const huge = { size: 256 * 1024 * 1024 + 1, text: () => Promise.reject(new Error('read the text')) } as unknown as Blob;

    expect(await readNamesFile(huge, 'script.json')).toEqual({ error: "script.json has more than 256 MB, which the engine can't open." });
});

test('provide skips a name with a control character and takes the other names of the file', async () => {
    const { engine, fileId } = await openBinary();
    const names = writeNamesFile([
        [await readRva('Player__Update'), 'Player$$Update'],
        [await readRva('Shapes_Circle__Area'), 'Shapes.Circle$$Area\nInjected'],
    ]);

    await engine.provide(fileId, 'script.json', names);
    const rowNames = readRows(await engine.list(fileId)).map(row => row.name);

    expect(rowNames).toContain('Player$$Update');
    expect(rowNames.filter(name => name.startsWith('Shapes.Circle$$Area') || name === 'Injected')).toEqual([]);
}, 120000);
