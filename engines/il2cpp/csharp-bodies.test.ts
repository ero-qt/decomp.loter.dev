import { findRow } from '#contract/checking';
import { type Document, formatTarget, readTokens } from '#contract/document';
import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadTestModule } from '../native/testing';
import { loadTestRuntime, openCodeGame } from './testing';

await Promise.all([loadTestRuntime(), loadTestModule()]);

let game = await openCodeGame();

afterAll(() => game.close());

// reads the C# that the engine wrote for a type of an earlier build of the code game, with `shared_0` as the name of
// shared code, whose name has the code's address
function readGolden(name: string): Promise<string> {
    return Bun.file(join(import.meta.dir, 'goldens', name)).text();
}

async function readText(type: string): Promise<string> {
    return (await game.readType(`Shapes.${type}`)).text.replace(/shared_[0-9a-f]+/g, 'shared_0');
}

// finds the target of the token on the first use of a word after a text of the document
function findTarget(document: Document, after: string, word: string): string | null | undefined {
    const start = document.text.indexOf(word, document.text.indexOf(after));

    return readTokens(document).find(token => token.start === start && token.length === word.length)?.target;
}

function rowTarget(path: string, image = 'Assembly-CSharp.dll'): string {
    return formatTarget({ fileId: 1, key: findRow(game.rows, `${image}.${path}`, 'global-metadata.dat').key });
}

test.each(['Shape', 'Circle', 'Square'])("the bodies of %s's methods read like C#", async type => {
    expect(await readText(type)).toBe(await readGolden(`${type}.cs`));
}, 120000);

test('a body writes calls, properties, operators, constructors and throws the way C# does', async () => {
    const circle = await readText('Circle');

    expect(circle).toContain('\t\tbase..ctor("shapes fixture");\n');
    expect(circle).toContain('\t\tpSVar1 = base.Describe();\n');
    expect(circle).toContain('\t\tbVar1 = this == other;\n');
    expect(circle).toContain('\t\t\tthis.Radius = iVar1 + 2;\n');
    expect(circle).toContain('\t\tthrow new NullReferenceException();\n');
    expect(circle).toContain('\t\t__this = new Circle(1);\n');
    expect(circle).toContain('\t\tthis.<Radius>k__BackingField = radius;\n');
}, 120000);

test("a body doesn't have the runtime's checks, its write barrier and the hidden argument of a call", async () => {
    const circle = await readText('Circle');

    expect(circle).not.toContain('il2cpp_');
    expect(circle).not.toContain('Il2CppCodeGenWriteBarrier');
    expect(circle).not.toContain('cctor_finished');
    expect(circle).not.toContain('method)');
}, 120000);

test('the names of a body link to the rows of their methods, fields and types', async () => {
    const circle = await game.readType('Shapes.Circle');

    expect(findTarget(circle, 'public Circle(int radius)', '<Radius>k__BackingField')).toBe(rowTarget('Shapes.Circle.<Radius>k__BackingField'));
    expect(findTarget(circle, 'piVar1 = &', 'Circle')).toBe(rowTarget('Shapes.Circle'));
    expect(findTarget(circle, 'piVar1 = &', 'count')).toBe(rowTarget('Shapes.Circle.count'));
    expect(findTarget(circle, '__this = new', 'Circle')).toBe(rowTarget('Shapes.Circle'));
    expect(findTarget(circle, 'public static Circle Unit()\n\t{\n\t\t', 'Circle')).toBe(rowTarget('Shapes.Circle'));
    expect(findTarget(circle, 'pSVar1 = base.', 'Describe')).toBe(rowTarget('Shapes.Shape.Describe()'));
}, 120000);

test("a property's name links to the property's row, not to its accessor's", async () => {
    const circle = await game.readType('Shapes.Circle');
    const findToken = (after: string, word: string) => {
        const start = circle.text.indexOf(word, circle.text.indexOf(after));

        return readTokens(circle).find(token => token.start === start);
    };

    expect(findToken('public bool Differs', 'IsUnit')).toMatchObject({ kind: 'property', target: rowTarget('Shapes.Circle.IsUnit') });
    expect(findToken('public void Grow', 'Radius')).toMatchObject({ kind: 'property', target: rowTarget('Shapes.Circle.Radius') });
}, 120000);

test("a local whose address a call passes by reference has the type of the call's parameter", async () => {
    const circle = await game.readType('Shapes.Circle');
    const find = circle.text.slice(circle.text.indexOf('public static int Find'));

    expect(find).toContain('\t\tbool var_9h;\n');
    expect(find).toContain('\t\tvar_9h = false;\n');
}, 120000);

test("a body reads an array's length and items the way C# does", async () => {
    const circle = await game.readType('Shapes.Circle');
    const total = circle.text.slice(circle.text.indexOf('public static int Total'), circle.text.indexOf('public static bool TryFind'));

    expect(total).toContain('\t\tint[] piVar1;\n');
    expect(total).toContain('piVar1.Length');
    expect(total).toContain('piVar1[');
    expect(total).not.toContain('0x18');
}, 120000);

test("a type's keyword in the header of a method with a compiler's name has a token, because the C# grammar leaves it plain", async () => {
    const circle = await game.readType('Shapes.Circle');
    const start = circle.text.indexOf('void <Grow>g__Step|9_0()');

    expect(readTokens(circle).find(token => token.start === start)).toMatchObject({ length: 4, kind: 'keyword', target: null });
}, 120000);

test("the exception of a throw links to the row of the exception's class", async () => {
    const circle = await game.readType('Shapes.Circle');
    const start = circle.text.indexOf('NullReferenceException', circle.text.indexOf('public void Grow'));
    const token = readTokens(circle).find(token => token.start === start);

    expect(token?.kind).toBe('class');
    expect(token?.target).toBe(rowTarget('System.NullReferenceException', 'mscorlib.dll'));
}, 120000);

test('the bodies of an ELF build read like the bodies of the Windows build', async () => {
    await game.close();
    game = await openCodeGame('libil2cpp.so');

    expect(await readText('Circle')).toBe(await readGolden('elf.Circle.cs'));
}, 120000);
