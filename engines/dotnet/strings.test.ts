import { expect, test } from 'bun:test';
import { findRow } from '../../contract/checking';
import { formatTarget } from '../../contract/document';
import { EngineError } from '../../contract/reply';
import { readRows } from '../../contract/rows';
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

test('dotnet engine lists a string once for each method that loads it and cuts a string after 1,000 characters', async () => {
    const engine = connect();
    const long = 'x'.repeat(1001);
    const assembly = await compileAssembly(
        'Repeated',
        `public class Use { public string[] A() => new[] { "same", "${long}" }; public string B(string s) => s == "same" ? s : "same"; }`,
    );
    const fileId = await engine.open(assembly.name, assembly);

    expect((await engine.listStrings(fileId)).map(use => use.text)).toEqual(['same', 'x'.repeat(1000), 'same']);
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
