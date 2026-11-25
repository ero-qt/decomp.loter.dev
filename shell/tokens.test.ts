import { expect, test } from 'bun:test';
import type { Token } from '#contract/document';
import { flagsOf, kinds, modifiers } from '#contract/symbols';
import { findToken, ownTokenTypes, readTokenModifiers, tokenLegend } from './tokens';

const standardTokenTypes = [
    'namespace',
    'class',
    'enum',
    'interface',
    'struct',
    'typeParameter',
    'type',
    'parameter',
    'variable',
    'property',
    'enumMember',
    'decorator',
    'event',
    'function',
    'method',
    'macro',
    'label',
    'comment',
    'string',
    'keyword',
    'number',
    'regexp',
    'operator',
];

test("token legend has each kind's semantic token type at the kind's index", () => {
    const typesByKind = Object.fromEntries(kinds.map((kind, index) => [kind, tokenLegend.tokenTypes[index]]));

    expect(typesByKind).toEqual({
        namespace: 'namespace',
        class: 'class',
        struct: 'struct',
        interface: 'interface',
        enum: 'enum',
        delegate: 'delegate',
        method: 'method',
        constructor: 'constructor',
        operator: 'operatorMethod',
        property: 'property',
        indexer: 'indexer',
        field: 'field',
        enum_member: 'enumMember',
        event: 'event',
        parameter: 'parameter',
        local: 'variable',
        type_parameter: 'typeParameter',
        label: 'label',
        opcode: 'opcode',
        record: 'record',
        annotation: 'annotation',
        section: 'namespace',
        reference: 'namespace',
        resource: 'string',
        function: 'function',
        variable: 'variable',
    });
});

test("own token types are the legend's types that the workbench doesn't have, each below a standard type", () => {
    expect(tokenLegend.tokenTypes.filter(type => !standardTokenTypes.includes(type))).toEqual(ownTokenTypes.map(type => type.id));
    expect(ownTokenTypes.filter(type => !standardTokenTypes.includes(type.superType))).toEqual([]);
});

test("token legend has the contract's modifiers, which readTokenModifiers reads from a token's flags without the accessibility", () => {
    expect(tokenLegend.tokenModifiers).toEqual([...modifiers]);
    expect(readTokenModifiers(flagsOf('public', 'static', 'declaration'))).toBe(
        (1 << modifiers.indexOf('static')) | (1 << modifiers.indexOf('declaration')),
    );
});

// `Draw(area)` with the method `Draw` at 0 to 4 and the local `area` at 5 to 9
const tokens: Token[] = [
    { start: 0, length: 4, kind: 'method', flags: 0, target: '1:4' },
    { start: 5, length: 4, kind: 'local', flags: 0, target: 'L:0' },
];

test("findToken finds the token at an offset from the token's start to the offset right after the token's end", () => {
    expect([0, 2, 4].map(offset => findToken(tokens, offset)?.target)).toEqual(['1:4', '1:4', '1:4']);
    expect(findToken(tokens, 9)?.target).toBe('L:0');
});

test('findToken returns undefined for an offset outside the tokens', () => {
    expect(findToken(tokens, 10)).toBeUndefined();
    expect(findToken([], 0)).toBeUndefined();
});

test('findToken takes the later of 2 tokens that touch at the offset', () => {
    const touching = [tokens[0], { ...tokens[1], start: 4 }];

    expect(findToken(touching, 4)?.target).toBe('L:0');
});

test('findToken takes the token with a target when 2 tokens touch at the offset', () => {
    const untargeted = { ...tokens[1], start: 4, target: null };

    expect(findToken([tokens[0], untargeted], 4)?.target).toBe('1:4');
});
