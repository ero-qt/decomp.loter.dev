import { findRow } from '#contract/checking';
import type { Engine } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { readRows } from '#contract/rows';
import { expect, test } from 'bun:test';
import { readBuildFile, type RealBuild, realBuilds, refusedMetadata } from './real-builds';
import { loadTestRuntime, useIl2CppEngine } from './testing';

const connect = useIl2CppEngine();
await loadTestRuntime();

// downloads the larger builds within the time, which takes a while on a slow connection
const buildTimeoutMs = 300000;

async function openBuild(engine: Engine, build: RealBuild) {
    const metadata = await readBuildFile(build.metadata);
    const fileId = await engine.open(metadata.name, metadata);
    await engine.provide(fileId, 'GameAssembly.dll', await readBuildFile(build.binary));
    const listing = await engine.list(fileId);
    const rows = readRows(listing);

    return { fileId, listing, rows, rowOf: (path: string) => findRow(rows, path, metadata.name) };
}

test('il2cpp engine reads the 2019.4 build with the newest layout of version 24 and its scripts with addresses', async () => {
    const engine = connect();
    const game = await openBuild(engine, realBuilds['2019.4.34']);
    const normal = game.rowOf('Assembly-CSharp.dll.NormalBehaviour');
    const methods = game.rows.filter(row => row.parent === game.rows.indexOf(normal) && row.kind === 'method');

    expect(game.listing.note).toBe('metadata 24.5, guessed among the layouts of version 24');
    expect(game.rowOf('Assembly-CSharp-firstpass.dll.FirstPassBehaviour').kind).toBe('class');
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every(row => /^0x[0-9a-f]+$/.test(row.detail))).toBe(true);
    // the addresses of `NormalBehaviour_Start_m…` and `NormalBehaviour__ctor_m…` in the 2019.4 build's GameAssembly.pdb
    expect(game.rowOf('Assembly-CSharp.dll.NormalBehaviour.Start()').detail).toBe('0x14dae0');
    expect(game.rowOf('Assembly-CSharp.dll.NormalBehaviour.NormalBehaviour()').detail).toBe('0x14da10');
    expect((await engine.read(game.fileId, normal.key, 'csharp')).text).toContain('public class NormalBehaviour : MonoBehaviour');
    expect(game.rows.some(row => row.name === '<Module>')).toBe(false);
}, buildTimeoutMs);

test("il2cpp engine reads the 2022.3 build, which doesn't have scripts, with layout 31.1 and Unity's types", async () => {
    const engine = connect();
    const game = await openBuild(engine, realBuilds['2022.3.35']);
    const behaviour = game.rowOf('UnityEngine.CoreModule.dll.UnityEngine.MonoBehaviour');

    expect(game.listing.note).toBe('metadata 31.1, guessed among the layouts of version 31');
    expect((await engine.read(game.fileId, behaviour.key, 'csharp')).text).toContain('public class MonoBehaviour : Behaviour');
}, buildTimeoutMs);

test("il2cpp engine writes a generic type's nested type without the generic parameters that it repeats from its parent", async () => {
    const engine = connect();
    const game = await openBuild(engine, realBuilds['2022.3.35']);
    const dictionary = game.rowOf('mscorlib.dll.System.Collections.Generic.Dictionary<TKey, TValue>');
    const nestedNames = game.rows.filter(row => row.parent === game.rows.indexOf(dictionary) && row.kind === 'struct').map(row => row.name);

    expect(nestedNames).toContain('Entry');
    expect((await engine.read(game.fileId, dictionary.key, 'csharp')).text).toContain('\tprivate Entry[] _entries;');
    const entry = game.rowOf('mscorlib.dll.System.Collections.Generic.Dictionary<TKey, TValue>.Entry');
    expect((await engine.read(game.fileId, entry.key, 'csharp')).text).toContain('\nprivate struct Entry\n{\n\tpublic int hashCode;\n');
}, buildTimeoutMs);

test("il2cpp engine refuses the 6000.5 alpha's layout of version 106 and the 6000.6 beta's version 108", async () => {
    const engine = connect();
    const alpha = await readBuildFile(refusedMetadata['6000.5.0a6']);
    const beta = await readBuildFile(refusedMetadata['6000.6.0b1']);
    const alphaRefusal = "global-metadata.dat has version 106, but the engine can't read its layout.";

    await expect(engine.open(alpha.name, alpha)).rejects.toThrow(new EngineError(alphaRefusal));
    await expect(engine.open(beta.name, beta)).rejects.toThrow(new EngineError("global-metadata.dat has version 108, which the engine can't read."));
}, buildTimeoutMs);
