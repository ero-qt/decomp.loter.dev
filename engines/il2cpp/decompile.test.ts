import { findRow } from '#contract/checking';
import { type Document, formatTarget, readTokens } from '#contract/document';
import type { Engine } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { readRows } from '#contract/rows';
import { modifiersOf } from '#contract/symbols';
import { expect, test } from 'bun:test';
import { readBuildFile, realBuilds } from './real-builds';
import { loadTestRuntime, readConstantGame, readFixture, useIl2CppEngine } from './testing';

const connect = useIl2CppEngine();
await loadTestRuntime();

interface GameFiles {
    withBinary?: boolean;
    metadata?: Promise<File>;
    binary?: Promise<File>;
}

// opens a game, the fixture's by default, and finds a row by its path, below `Assembly-CSharp.dll` without an image
async function openGame(engine: Engine, files: GameFiles = {}) {
    const metadataFile = await (files.metadata ?? readFixture('global-metadata.dat'));
    const fileId = await engine.open(metadataFile.name, metadataFile);
    if (files.withBinary ?? true) {
        await engine.provide(fileId, 'GameAssembly.dll', await (files.binary ?? readFixture('GameAssembly.dll')));
    }

    const rows = readRows(await engine.list(fileId));
    const rowOf = (path: string) => findRow(rows, path.includes('.dll.') ? path : `Assembly-CSharp.dll.${path}`, metadataFile.name);

    return {
        fileId,
        rowOf,
        targetOf: (path: string) => formatTarget({ fileId, key: rowOf(path).key }),
        read: (path: string) => engine.read(fileId, rowOf(path).key, 'csharp'),
    };
}

function findTokenText(document: Document, word: string) {
    return readTokens(document).filter(({ start, length }) => document.text.slice(start, start + length) === word);
}

test("il2cpp engine writes Circle's stub with the .NET engine's decompiler, with types and without the addresses", async () => {
    const game = await openGame(connect());

    expect((await game.read('Shapes.Circle')).text).toBe(`namespace Shapes;

public class Circle : Shape, IDrawable
{
	private float radius;

	public static int count;

	public float Radius { get; set; }

	public Circle(float radius)
	{
	}

	public override float Area()
	{
	}

	public virtual void Draw()
	{
	}

	public static Circle Unit()
	{
	}

	public float[] Scale(float[] factors)
	{
	}
}
`);
});

test("il2cpp engine's stubs write constants, abstract methods and nested types in their own document", async () => {
    const game = await openGame(connect());

    expect((await game.read('Shapes.Color')).text).toContain('public enum Color\n{\n\tRed,\n\tGreen,\n\tBlue\n}\n');
    const shape = (await game.read('Shapes.Shape')).text;

    expect(shape).toContain('public abstract class Shape\n');
    expect(shape).toContain('\tpublic abstract float Area();\n');
    expect((await game.read('Shapes.Circle')).text).not.toContain('Builder');
    expect((await game.read('Shapes.Circle.Builder')).text).toContain('public class Builder\n');
});

test("il2cpp engine's stub declares the type and its members and links the types in signatures to their rows", async () => {
    const game = await openGame(connect());
    const circle = await game.read('Shapes.Circle');
    const declared = readTokens(circle)
        .filter(token => modifiersOf(token.flags).includes('declaration') && token.kind !== 'parameter')
        .map(token => [circle.text.slice(token.start, token.start + token.length), token.kind, token.target]);

    expect(declared).toEqual([
        ['Circle', 'class', game.targetOf('Shapes.Circle')],
        ['radius', 'field', game.targetOf('Shapes.Circle.radius')],
        ['count', 'field', game.targetOf('Shapes.Circle.count')],
        ['Radius', 'property', game.targetOf('Shapes.Circle.Radius')],
        ['Circle', 'class', game.targetOf('Shapes.Circle.Circle(float)')],
        ['Area', 'method', game.targetOf('Shapes.Circle.Area()')],
        ['Draw', 'method', game.targetOf('Shapes.Circle.Draw()')],
        ['Unit', 'method', game.targetOf('Shapes.Circle.Unit()')],
        ['Scale', 'method', game.targetOf('Shapes.Circle.Scale(float[])')],
    ]);
    expect(findTokenText(circle, 'Shape').map(token => [token.kind, token.target])).toEqual([['class', game.targetOf('Shapes.Shape')]]);
    expect(findTokenText(circle, 'IDrawable').map(token => token.target)).toEqual([game.targetOf('Shapes.IDrawable')]);
});

test("il2cpp engine colors a type in another type's generic arguments and leaves bool to its keyword, like the .NET engine", async () => {
    const build = realBuilds['2019.4.34'];
    const game = await openGame(connect(), { metadata: readBuildFile(build.metadata), binary: readBuildFile(build.binary) });
    const task = await game.read('mscorlib.dll.System.Threading.Tasks.Task<TResult>');
    const field = task.text.indexOf('Func<Task<Task>, Task<TResult>> TaskWhenAnyCast');
    const tokenAt = (text: string) => readTokens(task).find(token => token.start === task.text.indexOf(text, field));

    expect(tokenAt('Task<Task>')).toMatchObject({ kind: 'class', target: game.targetOf('mscorlib.dll.System.Threading.Tasks.Task<TResult>') });
    expect(tokenAt('Task>')).toMatchObject({ kind: 'class', target: game.targetOf('mscorlib.dll.System.Threading.Tasks.Task') });
    expect(tokenAt('TResult>>')).toMatchObject({ kind: 'type_parameter' });
    expect(findTokenText(task, 'bool')).toEqual([]);
    expect(task.text).toContain('internal bool TrySetResult(TResult result)');
}, 120000);

test("il2cpp engine writes stubs with names only before it has the game's binary", async () => {
    const game = await openGame(connect(), { withBinary: false });
    const text = (await game.read('Shapes.Circle')).text;

    expect(text).toContain('public class Circle\n');
    expect(text).toContain(' radius;\n');
    expect(text).toContain(' Area()\n');
});

test("il2cpp engine's stub without the binary shows the metadata's modifiers, and object for each type with a note on top", async () => {
    const game = await openGame(connect(), { withBinary: false });
    const text = (await game.read('Shapes.Circle')).text;

    expect(text.split('\n').slice(0, 2)).toEqual([
        '// Load GameAssembly.dll or libil2cpp.so to show type information.',
        '// Types show as object until then.',
    ]);
    expect(text).toContain('\tprivate object radius;\n');
    expect(text).toContain('\tpublic static object Unit()\n');
    expect(text).toContain('\tpublic object Scale(object factors)\n');
    expect(text).not.toContain('?');
});

test("il2cpp engine refuses to read a member, which doesn't have its own document", async () => {
    const engine = connect();
    const game = await openGame(engine);

    await expect(engine.read(game.fileId, game.rowOf('Shapes.Circle.radius').key, 'csharp')).rejects.toThrow(
        new EngineError("radius doesn't have its own document."),
    );
});

test("il2cpp engine's stub escapes a string constant's line break and control characters", async () => {
    const game = await openGame(connect(), { metadata: readConstantGame('global-metadata.dat'), binary: readConstantGame('GameAssembly.dll') });

    expect((await game.read('Player')).text).toContain('\tpublic const string Greeting = "Hi\\nthere\\t\\u0001\\"";\n');
});
