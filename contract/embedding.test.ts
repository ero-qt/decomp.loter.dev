import { expect, test } from 'bun:test';
import { type Token, writeTokens } from './document';
import { indentLines, placeTokens, sliceBody } from './embedding';

const call: Token = { start: 0, length: 0, kind: 'method', flags: 0, target: '1:1050' };
const local: Token = { start: 0, length: 0, kind: 'variable', flags: 0, target: 'L:0' };

// writes a C function whose body calls `Area` and returns the local `x`, with a token on each name
function writeFunction() {
    const text = 'int f(void)\n{\n  Area();  \n\n  return x;\n}\n';
    const tokens = [
        { ...call, start: text.indexOf('Area'), length: 4 },
        { ...local, start: text.indexOf('x;'), length: 1 },
    ];

    return writeTokens(text, tokens, ['int x']);
}

test("sliceBody takes the lines between a function's braces with the tokens on them", () => {
    const body = sliceBody(writeFunction())!;

    expect(body.text).toBe('  Area();  \n\n  return x;');
    expect(body.tokens.map(token => body.text.slice(token.start, token.start + token.length))).toEqual(['Area', 'x']);
    expect(body.locals).toEqual(['int x']);
    expect(sliceBody(writeTokens('int f(void);\n', [], []))).toBeUndefined();
});

test("indentLines indents each line that isn't empty, drops the spaces at the lines' ends and moves the tokens along", () => {
    const body = indentLines(sliceBody(writeFunction())!, '    ');

    expect(body.text).toBe('      Area();\n\n      return x;');
    expect(body.tokens.map(token => body.text.slice(token.start, token.start + token.length))).toEqual(['Area', 'x']);
});

test('placeTokens moves the tokens to the start, the locals past the own locals and maps each other target', () => {
    const body = sliceBody(writeFunction())!;

    const placed = placeTokens(body, 100, 3, target => (target === '1:1050' ? '1:20000000' : null));

    expect(placed.map(({ start, target }) => [start, target])).toEqual([
        [102, '1:20000000'],
        [100 + body.text.indexOf('x'), 'L:3'],
    ]);
});
