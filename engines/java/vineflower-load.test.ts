import { EngineError } from '#contract/reply';
import { readRows } from '#contract/rows';
import { expect, mock, test } from 'bun:test';
import { classFile, useJavaEngine, zipFile } from './testing';

const connect = useJavaEngine();
let imports = 0;

// fails the first import of Vineflower's chunk like a lost connection, and gives a chunk without a decompiler after it
mock.module('@run-slicer/vf/vf.runtime.js', () => {
    imports++;
    if (imports === 1) {
        throw new Error('The chunk failed to load.');
    }

    return {};
});

test("java engine refuses a read while Vineflower's chunk doesn't load and imports the chunk again on the next read", async () => {
    const engine = connect();
    const jar = new File([zipFile([{ name: 'a/B.class', bytes: classFile({ name: 'a/B' }) }])], 'app.jar');
    const fileId = await engine.open(jar.name, jar);
    const [row] = readRows(await engine.list(fileId)).filter(found => found.name === 'B');

    const refusal = await engine.read(fileId, row.key, 'java').catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(EngineError);
    expect((refusal as EngineError).message).toBe("The engine can't load Vineflower: The chunk failed to load.");
    await expect(engine.read(fileId, row.key, 'java')).rejects.toThrow("Vineflower can't decompile a/B: ");
});
