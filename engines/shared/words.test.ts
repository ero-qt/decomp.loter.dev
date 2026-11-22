import { expect, test } from 'bun:test';
import { readTokens } from '../../contract/document';
import { findWords, type Word, type WordSyntax, writeWordTokens } from './words';

const lua: WordSyntax = { lineComment: '--', quotes: ['"', "'"], longBrackets: true, identifier: /[A-Za-z_]\w*/ };
const gml: WordSyntax = { lineComment: '//', blockComment: ['/*', '*/'], quotes: ['"'], identifier: /[A-Za-z_]\w*/ };

function readTexts(text: string, syntax: WordSyntax): string[] {
    return findWords(text, syntax).map(word => word.text);
}

test('findWords finds each word with its start, length and line', () => {
    expect(findWords('local x = 1\nreturn x\n', lua)).toEqual([
        { start: 0, length: 5, text: 'local', line: 0 },
        { start: 6, length: 1, text: 'x', line: 0 },
        { start: 12, length: 6, text: 'return', line: 1 },
        { start: 19, length: 1, text: 'x', line: 1 },
    ]);
});

test('findWords skips strings with escaped quotes and line comments', () => {
    expect(readTexts('print("a \\" b", \'c\') -- d e\nf\n', lua)).toEqual(['print', 'f']);
});

test('findWords skips block comments over lines and keeps counting lines', () => {
    expect(findWords('a /* b\nc */ d\n', gml).map(({ text, line }) => [text, line])).toEqual([
        ['a', 0],
        ['d', 1],
    ]);
});

test("findWords skips Lua's long strings and long comments", () => {
    expect(readTexts('a = [[b\nc]] --[==[ d ]] e ]==] f\n', lua)).toEqual(['a', 'f']);
});

test("findWords doesn't start a word inside a number or another word", () => {
    expect(readTexts('x = 0x1F + 2e5 + a1\n', lua)).toEqual(['x', 'a1']);
});

test('findWords takes the identifier pattern of the syntax, like names with a dollar sign', () => {
    const wat: WordSyntax = { lineComment: ';;', blockComment: ['(;', ';)'], quotes: ['"'], identifier: /\$[\w.$]+/ };

    expect(readTexts('(func $area (param $0 i32) ;; $not\n  call $draw.circle)\n', wat)).toEqual(['$area', '$0', '$draw.circle']);
});

test('writeWordTokens writes a token for each word that pick gives a kind, with the locals', () => {
    const text = 'local x = y\n';
    const pick = (word: Word) => (word.text === 'x' ? { kind: 'local' as const, flags: 0, target: 'L:0' } : undefined);
    const document = writeWordTokens(text, findWords(text, lua), pick, ['local x']);

    expect(readTokens(document)).toEqual([{ start: 6, length: 1, kind: 'local', flags: 0, target: 'L:0' }]);
    expect(document.locals).toEqual(['local x']);
});
