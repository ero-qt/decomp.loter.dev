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

test("the note of shared code links each method that shares the code to the method's row", async () => {
    const square = await game.readType('Shapes.Square');
    const start = square.text.indexOf('Circle.get_Radius');
    const link = readTokens(square).find(token => token.start === start);
    const getter = findRow(game.rows, 'Assembly-CSharp.dll.Shapes.Circle.Radius.get_Radius()', 'global-metadata.dat');

    expect(square.text).toContain('// Shares its code with Circle.get_Radius.');
    expect(link).toMatchObject({ length: 'Circle.get_Radius'.length, kind: 'method', target: formatTarget({ fileId: 1, key: getter.key }) });
}, 120000);

test("a call of shared code doesn't have the name of 1 of the methods that share it", async () => {
    const twice = cutMember((await game.readType('Shapes.Square')).text, 'public int Twice()');

    expect(twice).toContain('shared_');
    expect(twice).not.toContain('get_Side');
}, 120000);
