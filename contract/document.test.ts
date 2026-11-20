import { expect, test } from 'bun:test';
import { formatTarget, parseTarget, readTokens, type Token, writeTokens } from './document';
import { flagsOf } from './symbols';

const text = 'class Circle : Shape\n';
const tokens: Token[] = [
    { start: 6, length: 6, kind: 'class', flags: flagsOf('public', 'declaration'), target: '1:2000004' },
    { start: 15, length: 5, kind: 'class', flags: flagsOf('public', 'abstract'), target: '|Shapes.dll|T:Shape' },
];

test('tokens come back the same from their written form', () => {
    expect(readTokens(writeTokens(text, tokens, []))).toEqual(tokens);
});

test('tokens with the same target share 1 entry in the targets', () => {
    const twice = writeTokens(text, [tokens[0], { ...tokens[1], target: '1:2000004' }], []);

    expect(twice.targets).toEqual(['1:2000004']);
});

test('token without a target comes back without a target', () => {
    const [token] = readTokens(writeTokens(text, [{ start: 0, length: 5, kind: 'opcode', flags: 0, target: null }], []));

    expect(token?.target).toBeNull();
});

test('readTokens refuses a token past the end of the text', () => {
    const written = writeTokens(text, [{ ...tokens[0], start: 18, length: 6 }], []);

    expect(() => readTokens(written)).toThrow('token 0 covers 18 to 24 outside a text of 21');
});

test('readTokens refuses a token with a start or a length below 0', () => {
    const written = writeTokens(text, [{ ...tokens[0], start: 3, length: -2 }], []);

    expect(() => readTokens(written)).toThrow('token 0 covers 3 to 1 outside a text of 21');
});

test('readTokens refuses an unknown kind and a target outside the targets', () => {
    const kind = writeTokens(text, tokens, []);
    const target = writeTokens(text, tokens, []);
    kind.tokens[2] = 99;
    target.tokens[4] = 2;

    expect(() => readTokens(kind)).toThrow('token 0 has the unknown kind 99');
    expect(() => readTokens(target)).toThrow('token 0 has the target 2 of 2 targets');
});

test('document keeps the declarations of its locals and readTokens refuses a local without a declaration', () => {
    const local: Token = { start: 0, length: 5, kind: 'local', flags: 0, target: 'L:1' };

    expect(writeTokens(text, [local], ['int a', 'int b']).locals).toEqual(['int a', 'int b']);
    expect(() => readTokens(writeTokens(text, [local], ['int a']))).toThrow('token 0 has the local 1 of 1 locals');
});

test('readTokens refuses a target that is none of the 3 targets', () => {
    for (const target of ['L:x', 'L:-1', 'garbage', '']) {
        const written = writeTokens(text, [{ ...tokens[0], target }], ['int a']);

        expect(() => readTokens(written)).toThrow(`token 0 has the target '${target}', which isn't a target`);
    }
});

test('readTokens refuses values that end inside a token', () => {
    const written = writeTokens(text, tokens, []);

    expect(() => readTokens({ ...written, tokens: written.tokens.subarray(0, 8) })).toThrow("8 values aren't 5 for each token");
});

test('readTokens refuses a token that starts before the end of the token before it', () => {
    const written = writeTokens(text, [tokens[0], { ...tokens[1], start: 10 }], []);

    expect(() => readTokens(written)).toThrow('token 1 starts at 10 before the end of token 0');
});

test('each of the 3 targets has its own text and comes back the same from it', () => {
    expect(formatTarget({ fileId: 1, key: 0x02000004 })).toBe('1:2000004');
    expect(formatTarget({ local: 3 })).toBe('L:3');
    expect(formatTarget({ outside: 'Shapes.dll|T:Shape' })).toBe('|Shapes.dll|T:Shape');

    expect(parseTarget('1:2000004')).toEqual({ fileId: 1, key: 0x02000004 });
    expect(parseTarget('L:3')).toEqual({ local: 3 });
    expect(parseTarget('|Shapes.dll|T:Shape')).toEqual({ outside: 'Shapes.dll|T:Shape' });
});

test('key with its top bit set comes back the same from its target', () => {
    expect(formatTarget({ fileId: 2, key: -1 })).toBe('2:ffffffff');
    expect(parseTarget('2:ffffffff')).toEqual({ fileId: 2, key: -1 });
});

test('parseTarget refuses a text that is none of the 3 targets and a key of more than 32 bits', () => {
    expect(() => parseTarget('2000004')).toThrow("'2000004' isn't a target");
    expect(() => parseTarget('1:1ffffffff')).toThrow("'1:1ffffffff' isn't a target");
});

test('readTokens refuses a text with a carriage return', () => {
    expect(() => readTokens(writeTokens('class Circle\r\n', [], []))).toThrow('the text has a carriage return at 12');
});

test('readTokens refuses a token that crosses a line end', () => {
    const written = writeTokens('class Circle\nclass Square\n', [{ ...tokens[0], length: 10 }], []);

    expect(() => readTokens(written)).toThrow('token 0 crosses the line end at 12');
});

test("readTokens refuses a text whose last line doesn't end with a line end", () => {
    expect(readTokens(writeTokens('', [], []))).toEqual([]);
    expect(() => readTokens(writeTokens('class Circle\nclass Square', [], []))).toThrow("the text doesn't end with a line end");
});
