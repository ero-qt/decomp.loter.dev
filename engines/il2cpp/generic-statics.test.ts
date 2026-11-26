import { findRow } from '#contract/checking';
import { type Document, formatTarget, readTokens } from '#contract/document';
import { afterAll, expect, test } from 'bun:test';
import { loadTestModule } from '../native/testing';
import { cutMember, loadTestRuntime, openCodeGame } from './testing';

await Promise.all([loadTestRuntime(), loadTestModule()]);

const game = await openCodeGame();

afterAll(() => game.close());

// reads the getter of `Board.Largest`, which reads `Singleton<Circle>.Instance.Radius` through the runtime generic
// context of `Singleton<Circle>`
async function readLargest(): Promise<{ board: Document; largest: string }> {
    const board = await game.readType('Shapes.Board');

    return { board, largest: cutMember(board.text, 'public static int Largest') };
}

function findTarget(document: Document, after: string, word: string): string | null | undefined {
    const start = document.text.indexOf(word, document.text.indexOf(after));

    return readTokens(document).find(token => token.start === start && token.length === word.length)?.target;
}

function rowTarget(path: string): string {
    return formatTarget({ fileId: 1, key: findRow(game.rows, `Assembly-CSharp.dll.${path}`, 'global-metadata.dat').key });
}

test("a static field of a generic class's instance, which the code finds in a runtime generic context, reads as Class.field", async () => {
    const { largest } = await readLargest();

    expect(largest).toContain('Singleton<Circle>.instance');
    expect(largest).not.toContain('0xb8');
}, 120000);

test("the static field of a generic class's instance links to the field and the class to the generic type", async () => {
    const { board } = await readLargest();

    expect(findTarget(board, 'Singleton<Circle>.instance', 'instance')).toBe(rowTarget('Shapes.Singleton<T>.instance'));
    expect(findTarget(board, 'Singleton<Circle>.instance', 'Singleton<Circle>')).toBe(rowTarget('Shapes.Singleton<T>'));
}, 120000);
