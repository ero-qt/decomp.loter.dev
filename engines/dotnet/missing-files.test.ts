import { expect, test } from 'bun:test';
import type { Engine } from '#contract/engine';
import { compileAssembly, loadTestRuntime, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

async function listMissingFileNames(engine: Engine, fileId: number): Promise<string[]> {
    return (await engine.list(fileId)).missingFiles.map(missingFile => missingFile.name);
}

test('Drawing.dll lists Shapes.dll as a missing file with its version until Shapes.dll is open', async () => {
    const engine = connect();
    const drawing = await readFixture('Drawing.dll');
    const shapes = await readFixture('Shapes.dll');
    const drawingId = await engine.open(drawing.name, drawing);

    expect((await engine.list(drawingId)).missingFiles).toContainEqual({ name: 'Shapes.dll', reason: '0.0.0.0, not loaded', isCompanion: false });

    await engine.open(shapes.name, shapes);
    expect(await listMissingFileNames(engine, drawingId)).not.toContain('Shapes.dll');
});

test('Drawing.dll lists the framework assemblies that it references as missing files', async () => {
    const engine = connect();
    const drawing = await readFixture('Drawing.dll');

    expect(await listMissingFileNames(engine, await engine.open(drawing.name, drawing))).toEqual([
        'System.Runtime.dll',
        'Shapes.dll',
        'System.Threading.dll',
        'System.Console.dll',
    ]);
});

test("a file lists a forwarded type's assembly as a missing file once the facade that forwards the type is open", async () => {
    const engine = connect();
    await compileAssembly('old/Facade', 'namespace Moved { public class Thing { } }');
    await compileAssembly('Target', 'namespace Moved { public class Thing { } }');
    const client = await compileAssembly('Client', 'public class User { public Moved.Thing Value; }', ['old/Facade']);
    const facade = await compileAssembly('Facade', '[assembly: System.Runtime.CompilerServices.TypeForwardedTo(typeof(Moved.Thing))]', ['Target']);
    const clientId = await engine.open(client.name, client);

    expect(await listMissingFileNames(engine, clientId)).toEqual(['System.Runtime.dll', 'Facade.dll']);

    await engine.open(facade.name, facade);
    expect(await listMissingFileNames(engine, clientId)).toEqual(['System.Runtime.dll', 'Target.dll']);
});
