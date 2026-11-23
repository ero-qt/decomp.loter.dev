import { expect, test } from 'bun:test';
import type { Engine } from '../../contract/engine';
import { readRows } from '../../contract/rows';
import { compileAssembly, findMetadataStream, loadTestRuntime, patchBytes, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

// tiny method header for 7 bytes of IL, ldarg.0, call with a MemberRef token, ret
const baseCallBody = [0x1e, 0x02, 0x28, undefined, undefined, undefined, 0x0a, 0x2a];

async function compileBytes(name: string, text: string, references: string[] = []): Promise<Uint8Array<ArrayBuffer>> {
    return (await compileAssembly(name, text, references)).bytes();
}

// lists a file with the path of each row, like `Kept.Run()`
async function listPaths(engine: Engine, name: string, bytes: Uint8Array<ArrayBuffer>) {
    const listing = await engine.list(await engine.open(name, new File([bytes], name)));
    const rows = readRows(listing);
    const paths: string[] = [];
    for (const { name: rowName, parent } of rows) {
        paths.push(parent < 0 ? rowName : `${paths[parent]}.${rowName}`);
    }

    return { listing, rows, paths };
}

test("dotnet engine skips a constructor whose body it can't read and counts it in the note", async () => {
    const text = 'public class Broken { public int Value; } public static class Kept { public static void Run() { } }';
    const bytes = await compileBytes('BrokenBody', text);
    patchBytes(bytes, baseCallBody, [0x00]);

    const { listing, paths } = await listPaths(connect(), 'BrokenBody.dll', bytes);

    expect(paths.filter(path => /^(Broken|Kept)/.test(path))).toEqual(['Broken', 'Broken.Value', 'Kept', 'Kept.Run()']);
    expect(listing.note).toBe("1 symbol that the engine can't read not shown");
});

test('dotnet engine lists a type that a crafted file nests in 2 types once and keeps reading the file', async () => {
    const engine = connect();
    const bytes = await compileBytes('TwiceNested', 'public class A { public class N { } } public class B { public class M { } }');
    const tables = findMetadataStream(bytes, '#~');
    // NestedClass rows (N, A), (M, B) become (N, A), (N, B)
    patchBytes(bytes, [4, 0, 2, 0, 5, 0, 3, 0], [4, 0, 2, 0, 4, 0, 3, 0], tables);

    const { listing, rows, paths } = await listPaths(engine, 'TwiceNested.dll', bytes);

    expect(paths.filter(path => /^[AB]\b/.test(path) && !path.endsWith(')'))).toEqual(['A', 'A.N', 'B']);
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
    expect(listing.note).toBe("1 symbol that the engine can't read not shown");
    expect((await engine.read(1, rows[paths.indexOf('B')].key, 'csharp')).text).toContain('class B');
});

test("dotnet engine skips a type reference whose assembly it can't read and keeps the other missing files", async () => {
    await compileAssembly('Lib', 'namespace Moved { public class Thing { } }');
    const bytes = await compileBytes('BrokenRef', 'public class User { public Moved.Thing Value; }', ['Lib']);
    const strings = findMetadataStream(bytes, '#Strings');
    const heap = Buffer.from(bytes.subarray(strings.start, strings.end));
    const [name, space] = ['Thing', 'Moved'].map(text => heap.indexOf(`\0${text}\0`) + 1);
    // points the TypeRef row of Moved.Thing at AssemblyRef row 99, which the file doesn't have
    const row = [undefined, undefined, name & 0xff, name >> 8, space & 0xff, space >> 8];
    const scope = (99 << 2) | 2;
    patchBytes(bytes, row, [scope & 0xff, scope >> 8], findMetadataStream(bytes, '#~'));

    const { listing, paths } = await listPaths(connect(), 'BrokenRef.dll', bytes);

    expect(listing.missingFiles.map(missingFile => missingFile.name)).toEqual(['System.Runtime.dll', 'Lib.dll']);
    expect(paths).toContain('User.Value');
    expect(listing.note).toBe("1 reference that the engine can't read not shown");
});

test("dotnet engine doesn't show a size for a resource whose length runs past the resources", async () => {
    const drawing = await readFixture('Drawing.dll');
    const bytes = await drawing.bytes();
    const palette = [...(await Bun.file(new URL('fixture/src/Drawing/palette.txt', import.meta.url)).bytes()).subarray(0, 8)];
    patchBytes(bytes, [undefined, undefined, undefined, undefined, ...palette], [0xff, 0xff, 0xff, 0x7f]);

    const { rows, paths } = await listPaths(connect(), drawing.name, bytes);

    expect(rows[paths.indexOf('Resources.palette.txt')].detail).toBe('');
});

test("dotnet engine doesn't find a symbol for an outside target whose ID string it can't parse", async () => {
    const engine = connect();
    const drawing = await readFixture('Drawing.dll');
    await engine.open(drawing.name, drawing);

    expect(await engine.resolve('|Drawing|T:{')).toBeNull();
    expect(await engine.findReferences('|Drawing|T:{', 'csharp')).toEqual([]);
});

test('dotnet engine lists the strings of a file but one whose length runs past the heap', async () => {
    const engine = connect();
    const text = 'public static class Texts { public static string A() => "kept"; public static string B() => "broken"; }';
    const bytes = await compileBytes('BrokenString', text);
    // the #US entry of "broken": its length with the final byte, then its UTF-16 text
    const broken = [...Buffer.from('broken', 'utf16le')];
    patchBytes(bytes, [broken.length + 1, ...broken], [0x7f], findMetadataStream(bytes, '#US'));
    const fileId = await engine.open('BrokenString.dll', new File([bytes], 'BrokenString.dll'));

    expect((await engine.listStrings(fileId)).map(string => string.text)).toEqual(['kept']);
});

// points the TypeRef row of `Lib.Other\`3` at itself as its scope. The row's number comes from its offset in the #~
// stream, where the TypeRef rows of 6 bytes follow the header, a row count per table and the Module row of 10 bytes
// (ECMA-335 II.24.2.6).
function pointScopeAtItself(bytes: Uint8Array<ArrayBuffer>) {
    const tables = findMetadataStream(bytes, '#~');
    const strings = findMetadataStream(bytes, '#Strings');
    const heap = Buffer.from(bytes.subarray(strings.start, strings.end));
    const [name, space] = ['Other`3', 'Lib'].map(text => heap.indexOf(`\0${text}\0`) + 1);
    const offset = patchBytes(bytes, [undefined, undefined, name & 0xff, name >> 8, space & 0xff, space >> 8], [], tables);

    const presentTables = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(tables.start + 8, true);
    const tableCount = [...presentTables.toString(2)].filter(bit => bit === '1').length;
    const row = (offset - (tables.start + 24 + tableCount * 4 + 10)) / 6 + 1;
    const scope = (row << 2) | 3;
    bytes.set([scope & 0xff, scope >> 8], offset);
}

// puts the file's only TypeSpec into its own signature as a modifier, so `Other<int, int, int>` becomes
// `Other<modopt(TypeSpec 1) int>` in a blob of the same length
function putSpecificationInItself(bytes: Uint8Array<ArrayBuffer>) {
    const offset = patchBytes(bytes, [7, 0x15, 0x12, undefined, 3, 8, 8, 8], [], findMetadataStream(bytes, '#Blob'));
    const typeSpecification = (1 << 2) | 2;
    bytes.set([1, 0x20, typeSpecification, 8], offset + 4);
}

test('dotnet engine writes the C# of a file with a generic instance whose type is its own scope or contains itself', async () => {
    await compileAssembly('Lib', 'namespace Lib { public class Other<A, B, C> { public void Run() { } } }');
    const text = [
        'public static class Kept { public static void Run() { System.Console.WriteLine(); } }',
        'public static class Broken { public static void Use() { new Lib.Other<int, int, int>().Run(); } }',
    ].join('\n');
    const compiled = await compileBytes('SelfNamed', text, ['Lib']);

    for (const breakFile of [pointScopeAtItself, putSpecificationInItself]) {
        const engine = connect();
        const bytes = compiled.slice();
        breakFile(bytes);
        const fileId = await engine.open('SelfNamed.dll', new File([bytes], 'SelfNamed.dll'));
        const rows = readRows(await engine.list(fileId));

        expect((await engine.read(fileId, rows.find(row => row.name === 'Kept')!.key, 'csharp')).text).toContain('Console.WriteLine();');
    }
});
