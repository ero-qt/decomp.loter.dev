import { findRow } from '#contract/checking';
import { formatTarget, readTokens } from '#contract/document';
import { afterAll, expect, test } from 'bun:test';
import { loadTestModule } from '../native/testing';
import { cutMember, loadTestRuntime, openCodeGame } from './testing';

await Promise.all([loadTestRuntime(), loadTestModule()]);

const game = await openCodeGame();

afterAll(() => game.close());

test("a getter that shares its code with another class's getter doesn't show the other class's field", async () => {
    const square = (await game.readType('Shapes.Square')).text;
    const side = cutMember(square, 'public int Side');

    expect(side).not.toContain('<Radius>k__BackingField');
    expect(side).toContain('// Shares its code with Circle.get_Radius.');
}, 120000);

test('the note of shared code names a constructor after its class', async () => {
    const square = (await game.readType('Shapes.Square')).text;

    expect(cutMember(square, 'public Square()')).toContain('// Shares its code with Circle.Circle, Square.Clear.');
}, 120000);

test("the note of shared code links each method that shares the code to the method's row", async () => {
    const square = await game.readType('Shapes.Square');
    const start = square.text.indexOf('Circle.get_Radius');
    const link = readTokens(square).find(token => token.start === start);
    const getter = findRow(game.rows, 'Assembly-CSharp.dll.Shapes.Circle.Radius.get_Radius()', 'global-metadata.dat');

    expect(square.text).toContain('// Shares its code with Circle.get_Radius.');
    expect(link).toMatchObject({ length: 'Circle.get_Radius'.length, kind: 'method', target: formatTarget({ fileId: 1, key: getter.key }) });
}, 120000);

test('a call of code that an operator shares reads as the operator', async () => {
    const same = cutMember((await game.readType('Shapes.Circle')).text, 'public bool Same(Circle other)');

    expect(same).toContain('bVar1 = this == other;');
}, 120000);

test('a call of shared code reads as the 1 method that shares the code and fits the call', async () => {
    const twice = cutMember((await game.readType('Shapes.Square')).text, 'public int Twice()');
    const isUnit = cutMember((await game.readType('Shapes.Circle')).text, 'public bool IsUnit');

    expect(twice).toContain('iVar1 = this.Side;');
    expect(isUnit).toContain('iVar1 = this.Radius;');
}, 120000);

test('a call of shared code that several methods fit keeps the name of the shared code', async () => {
    const widest = cutMember((await game.readType('Shapes.Square')).text, 'public int Widest(int other)');

    expect(widest).toContain('shared_');
    expect(widest).not.toContain('Larger');
    expect(widest).not.toContain('Bigger');
}, 120000);

test("the name that a call of shared code reads as links to the method's row", async () => {
    const square = await game.readType('Shapes.Square');
    const start = square.text.indexOf('Side', square.text.indexOf('public int Twice()'));
    const side = findRow(game.rows, 'Assembly-CSharp.dll.Shapes.Square.Side', 'global-metadata.dat');

    expect(readTokens(square).find(token => token.start === start)).toMatchObject({
        length: 'Side'.length,
        kind: 'property',
        target: formatTarget({ fileId: 1, key: side.key }),
    });
}, 120000);

test("a call of a shared constructor on a new object of the constructor's type reads as new", async () => {
    const make = cutMember((await game.readType('Shapes.Square')).text, 'public static Square Make()');

    expect(make).toContain(' = new Square();');
    expect(make).not.toContain('shared_');
    expect(make).not.toContain('..ctor');
}, 120000);

test("a call of a shared constructor that doesn't make a new object keeps the name of the shared code", async () => {
    const wipe = cutMember((await game.readType('Shapes.Circle')).text, 'public void Wipe()');

    expect(wipe).toContain('shared_');
    expect(wipe).not.toContain('..ctor');
}, 120000);
