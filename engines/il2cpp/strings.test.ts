import { expect, test } from 'bun:test';
import { loadTestRuntime, readFixture, useIl2CppEngine } from './testing';

const connect = useIl2CppEngine();
await loadTestRuntime();

test("il2cpp engine lists the metadata's string literals without users, because the users are in the binary's code", async () => {
    const engine = connect();
    const metadata = await readFixture('global-metadata.dat');
    const fileId = await engine.open(metadata.name, metadata);

    expect(await engine.listStrings(fileId)).toEqual([
        { text: 'shapes fixture', user: null },
        { text: 'héllo ✓', user: null },
    ]);
});
