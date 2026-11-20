import { expect, test } from 'bun:test';
import { createPositionFinder } from './lines';

const text = 'class Shape\n{\n\n    int sides;\n}\n';

// counts the lines of the text before the offset, like a reader that splits the text at each `\n`
function findBySplit(offset: number) {
    const lines = text.slice(0, offset).split('\n');

    return { line: lines.length - 1, character: lines.at(-1)!.length };
}

test("createPositionFinder's function finds each offset's line and character like a split of the text before the offset", () => {
    const findPosition = createPositionFinder(text);
    const offsets = Array.from({ length: text.length + 1 }, (_, offset) => offset);

    expect(offsets.map(findPosition)).toEqual(offsets.map(findBySplit));
});

test("createPositionFinder's function puts an offset past the text's end at the text's end", () => {
    expect(createPositionFinder(text)(text.length + 5)).toEqual({ line: 5, character: 0 });
    expect(createPositionFinder('a\nbc')(10)).toEqual({ line: 1, character: 2 });
});

test("createPositionFinder's function finds the first line's start in an empty text", () => {
    expect(createPositionFinder('')(0)).toEqual({ line: 0, character: 0 });
});
