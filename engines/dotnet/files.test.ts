import { EngineError, failed, ok } from '#contract/reply';
import { expect, test } from 'bun:test';
import { createDotnetHandlers } from './handlers';
import { compileAssembly, loadTestRuntime, peFile, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

// nests a class the count of levels deep, like `class N1 { class N2 { } }` for 2
function nestClasses(levels: number): string {
    const names = Array.from({ length: levels }, (_, index) => `N${index + 1}`);

    return `${names.map(name => `class ${name} {`).join(' ')} ${'}'.repeat(levels)}`;
}

test("dotnet engine opens the fixture and refuses a file that isn't an assembly with an engine error", async () => {
    const engine = connect();
    const drawing = await readFixture('Drawing.dll');
    const broken = new File([peFile({})], 'broken.dll');

    await engine.close(await engine.open(drawing.name, drawing));
    await expect(engine.open(broken.name, broken)).rejects.toBeInstanceOf(EngineError);
    await expect(engine.open(broken.name, broken)).rejects.toThrow("broken.dll isn't a readable .NET assembly.");
});

test('dotnet engine refuses an assembly over 256 MB before it reads the assembly', async () => {
    const handlers = createDotnetHandlers(loadTestRuntime);
    const signal = new AbortController().signal;
    const huge = { size: 256 * 1024 * 1024 + 1, bytes: () => Promise.reject(new Error('The engine read the assembly.')) } as unknown as Blob;

    expect(await handlers.open(1, 'huge.dll', huge, signal)).toEqual(failed("huge.dll has more than 256 MB, which the engine can't open."));
});

test('dotnet engine refuses to provide a missing file and refuses a close for a file that it closed', async () => {
    const engine = connect();
    const handlers = createDotnetHandlers(loadTestRuntime);
    const signal = new AbortController().signal;
    const drawing = await readFixture('Drawing.dll');

    const fileId = await engine.open(drawing.name, drawing);

    await expect(engine.provide(fileId, 'Drawing.pdb', drawing)).rejects.toThrow("The .NET engine doesn't take other files.");
    expect(await handlers.open(1, drawing.name, drawing, signal)).toEqual(ok(undefined));
    expect(await handlers.close(1, signal)).toEqual(ok(undefined));
    expect(await handlers.close(1, signal)).toEqual(failed("The .NET engine doesn't have an open file with the id 1."));
});

test('dotnet engine opens types nested 256 levels deep and refuses one level more', async () => {
    const engine = connect();
    const deepest = await compileAssembly('Deepest', nestClasses(257));
    const deeper = await compileAssembly('Deeper', nestClasses(258));

    await engine.close(await engine.open(deepest.name, deepest));
    await expect(engine.open(deeper.name, deeper)).rejects.toThrow('Deeper.dll has types that are nested more than 256 levels deep.');
});
