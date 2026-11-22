import { useInThreadWorker } from '#contract/in-thread-worker';
import { expect, test } from 'bun:test';
import { createIl2CppHandlers } from './handlers';
import { connectIl2Cpp, loadTestRuntime, readFixture, useIl2CppEngine } from './testing';

const connect = useIl2CppEngine();

test('il2cpp engine claims global-metadata.dat under any name', async () => {
    const engine = connect();
    const metadata = await readFixture('global-metadata.dat');

    expect(await engine.claims('data.bin', new File([metadata], 'data.bin'))).toBe(true);
    expect(await engine.claims(metadata.name, metadata)).toBe(true);
});

test("il2cpp engine doesn't claim another .dat file, a cut magic or the game's binary", async () => {
    const engine = connect();
    const text = new File(['level data'], 'level0.dat');
    const cut = new File([new Uint8Array([0xaf, 0x1b, 0xb1])], 'global-metadata.dat');
    const binary = await readFixture('GameAssembly.dll');

    expect(await engine.claims(text.name, text)).toBe(false);
    expect(await engine.claims(cut.name, cut)).toBe(false);
    expect(await engine.claims(binary.name, binary)).toBe(false);
});

test("il2cpp engine's claims doesn't load the runtime and its first open does", async () => {
    let loads = 0;
    useInThreadWorker(() => createIl2CppHandlers(() => {
        loads++;

        return loadTestRuntime();
    }));
    const engine = connectIl2Cpp();
    const metadata = await readFixture('global-metadata.dat');

    await engine.claims(metadata.name, metadata);
    expect(loads).toBe(0);

    await engine.open(metadata.name, metadata);
    expect(loads).toBe(1);
}, 120000);
