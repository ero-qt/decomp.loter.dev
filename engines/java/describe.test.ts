import { expect, test } from 'bun:test';
import { findRow, missingView } from '#contract/checking';
import { formatTarget } from '#contract/document';
import type { Engine } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { readRows } from '#contract/rows';
import { fixture } from './fixture';
import { classFile, useJavaEngine, zipFile } from './testing';

const connect = useJavaEngine();

// opens the file and returns the function that finds the target of the row with a path, like `drawing.Main`
async function openFile(engine: Engine, file: File): Promise<(path: string) => string> {
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));

    return path => formatTarget({ fileId, key: findRow(rows, path, file.name).key });
}

// opens the fixture's JAR and returns its id and the target of `drawing.Main`'s row
async function openMain(engine: Engine): Promise<{ fileId: number; target: string }> {
    const fileId = await engine.open(fixture.file.name, fixture.file);
    const rows = readRows(await engine.list(fileId));

    return { fileId, target: formatTarget({ fileId, key: findRow(rows, 'drawing.Main', fixture.file.name).key }) };
}

test("java engine describes a method with its declaration and its class's full name", async () => {
    const engine = connect();
    const targetOf = await openFile(engine, fixture.file);

    expect(await engine.describe(targetOf('drawing.Main.classify'), 'java')).toEqual({
        text: 'public static String classify(Shape)',
        container: 'drawing.Main',
        facts: [],
        missingFile: null,
    });
});

test('java engine describes packages, classes and members with the names that contain them', async () => {
    const engine = connect();
    const targetOf = await openFile(engine, fixture.file);
    const paths = [
        '',
        '.Main',
        '.Circle',
        '.Marker',
        '.Named',
        '.Box',
        '.Main.Entry',
        '.Main.Entry.key',
        '.Main.hits',
        '.Main.sum',
        '.Main.Cursor.Cursor',
        '.Color.RED',
        '.Named.label',
    ];
    const descriptions = await Promise.all(paths.map(path => engine.describe(targetOf(`drawing${path}`), 'java')));

    expect(descriptions.map(description => [description?.text, description?.container])).toEqual([
        ['package drawing', null],
        ['public final class Main', 'drawing'],
        ['public record Circle(double radius)', 'drawing'],
        ['public @interface Marker', 'drawing'],
        ['public sealed interface Named', 'drawing'],
        ['public class Box<T>', 'drawing'],
        ['public static class Entry', 'drawing.Main'],
        ['public String key', 'drawing.Main.Entry'],
        ['private transient int hits', 'drawing.Main'],
        ['public static int sum(int...)', 'drawing.Main'],
        ['public Cursor()', 'drawing.Main.Cursor'],
        ['public static final Color RED', 'drawing.Color'],
        ['public default String label()', 'drawing.Named'],
    ]);
});

test('java engine describes a symbol outside the open files from its target and nothing for a local', async () => {
    const engine = connect();

    expect(await engine.describe('|java/lang/String#trim#()Ljava/lang/String;', 'java')).toEqual({
        text: 'String trim()',
        container: 'java.lang.String',
        facts: [],
        missingFile: null,
    });
    expect(await engine.describe('|java/util/Map$Entry', 'java')).toEqual({
        text: 'java.util.Map.Entry',
        container: null,
        facts: [],
        missingFile: null,
    });
    expect((await engine.describe('|java/io/PrintStream#out#Ljava/io/PrintStream;', 'java'))?.text).toBe('PrintStream out');
    expect((await engine.describe('|java/util/ArrayList#<init>#(I)V', 'java'))?.text).toBe('ArrayList(int)');
    expect(await engine.describe('L:0', 'java')).toBeNull();
});

test("java engine describes nothing for a closed file's row and refuses a view that it doesn't have", async () => {
    const engine = connect();
    const { fileId, target } = await openMain(engine);
    await engine.close(fileId);

    expect(await engine.describe(target, 'java')).toBeNull();
    await expect(engine.describe(target, missingView)).rejects.toBeInstanceOf(EngineError);
});

test('java engine resolves symbols outside the open files to rows of any open file, through super classes', async () => {
    const engine = connect();
    await openFile(engine, fixture.file);
    const shapesOf = await openFile(engine, fixture.linked.file);
    const resolved = await Promise.all(['|shapes/Shape#area#()D', '|drawing/Box#sides#I', '|shapes/Shape'].map(target => engine.resolve(target)));

    expect(resolved).toEqual([shapesOf('shapes.Shape.area'), shapesOf('shapes.Base.sides'), shapesOf('shapes.Shape')]);
    expect(await engine.resolve(shapesOf('shapes.Base'))).toBe(shapesOf('shapes.Base'));
});

test("java engine resolves nothing for a JDK symbol, a member without a row, a local and a closed file's row", async () => {
    const engine = connect();
    const { fileId, target } = await openMain(engine);
    const unresolved = [
        '|java/lang/String',
        '|java/lang/String#trim#()Ljava/lang/String;',
        '|drawing/Main#lambda$run$0#(Ljava/lang/String;)V',
        'L:0',
    ];

    expect(await Promise.all(unresolved.map(outside => engine.resolve(outside)))).toEqual([null, null, null, null]);
    await engine.close(fileId);
    expect(await engine.resolve(target)).toBeNull();
});

test('java engine keeps a class whose name has a `#` apart from members', async () => {
    const engine = connect();
    const jar = zipFile([
        { name: 'a/B#C.class', bytes: classFile({ name: 'a/B#C', fields: [{ name: 'size', descriptor: 'I' }] }) },
        { name: 'a/D.class', bytes: classFile({ name: 'a/D', fields: [{ name: 'item', descriptor: 'La/B#C;' }] }) },
    ]);
    const targetOf = await openFile(engine, new File([jar], 'app.jar'));
    const descriptions = await Promise.all(['a.B#C', 'a.B#C.size'].map(path => engine.describe(targetOf(path), 'java')));

    expect(descriptions.map(description => [description?.text, description?.container])).toEqual([
        ['public class B#C', 'a'],
        ['public int size', 'a.B#C'],
    ]);
    expect(await engine.describe('|x/Y#Z', 'java')).toEqual({ text: 'x.Y#Z', container: null, facts: [], missingFile: null });
    expect(await engine.resolve('|a/B#C')).toBe(targetOf('a.B#C'));
    expect(await engine.resolve('|a/B#C#size#I')).toBe(targetOf('a.B#C.size'));
    const references = await engine.findReferences(targetOf('a.B#C'), 'java');

    expect(references.map(reference => reference.user).sort()).toEqual([targetOf('a.B#C'), targetOf('a.D')]);
});
