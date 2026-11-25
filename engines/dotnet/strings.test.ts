import { findRow } from '#contract/checking';
import { formatTarget } from '#contract/document';
import { maxStringLength, maxStrings } from '#contract/limits';
import { EngineError } from '#contract/reply';
import { readRows } from '#contract/rows';
import { expect, test } from 'bun:test';
import { compileAssembly, loadTestRuntime, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

test("strings of Drawing.dll include 'héllo ✓' with Painter.Paint as its user", async () => {
    const engine = connect();
    const drawing = await readFixture('Drawing.dll');
    const fileId = await engine.open(drawing.name, drawing);
    const rows = readRows(await engine.list(fileId));
    const targetOf = (path: string) => formatTarget({ fileId, key: findRow(rows, path, drawing.name).key });

    expect(await engine.listStrings(fileId)).toEqual([
        { text: 'héllo ✓', user: targetOf('Drawing.Painter.Paint(Shape)') },
        { text: 'draft', user: targetOf('Drawing.Sketch') },
        { text: 'final', user: targetOf('Drawing.Sketch') },
    ]);
});

test('dotnet engine lists a string once for each method that loads it and cuts a string above 1,000 characters with a mark', async () => {
    const engine = connect();
    const long = 'x'.repeat(1001);
    const whole = 'y'.repeat(1000);
    const assembly = await compileAssembly(
        'Repeated',
        `public class Use { public string[] A() => new[] { "same", "${long}", "${whole}" }; public string B(string s) => s == "same" ? s : "same"; }`,
    );
    const fileId = await engine.open(assembly.name, assembly);

    expect((await engine.listStrings(fileId)).map(use => use.text)).toEqual(['same', `${'x'.repeat(999)}…`, whole, 'same']);
});

test('dotnet engine cuts a long string before a surrogate pair that the cut would split', async () => {
    const engine = connect();
    const split = `${'x'.repeat(998)}😀${'x'.repeat(10)}`;
    const assembly = await compileAssembly('Split', `public class Use { public string A() => "${split}"; }`);
    const fileId = await engine.open(assembly.name, assembly);

    expect((await engine.listStrings(fileId)).map(use => use.text)).toEqual([`${'x'.repeat(998)}…`]);
});

test("dotnet engine lists a file's first 50,000 strings and says so in the file's note", async () => {
    const engine = connect();
    const methods = Array.from({ length: 51 }, (_, method) => {
        const texts = Array.from({ length: 1000 }, (_, index) => `"s${method}_${index}"`);

        return `public static string[] M${method}() => new[] { ${texts.join(', ')} };`;
    });
    const assembly = await compileAssembly('ManyStrings', `public static class Texts { ${methods.join(' ')} }`);
    const fileId = await engine.open(assembly.name, assembly);

    expect((await engine.list(fileId)).note).toBe('first 50,000 strings listed');
    expect(await engine.listStrings(fileId)).toHaveLength(50000);
});

test("dotnet engine refuses to list the strings of a file that isn't open", async () => {
    await expect(connect().listStrings(1)).rejects.toBeInstanceOf(EngineError);
});

test("Limits.cs lists as many strings as the contract and cuts them at the contract's length", async () => {
    const limits = await Bun.file(new URL('src/Limits.cs', import.meta.url)).text();
    const readConstant = (name: string) => Number(new RegExp(`const int ${name} = ([\\d_]+);`).exec(limits)?.[1].replaceAll('_', ''));

    expect(readConstant('MaxStrings')).toBe(maxStrings);
    expect(readConstant('MaxStringLength')).toBe(maxStringLength);
});
