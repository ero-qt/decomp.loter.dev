import { expect, test } from 'bun:test';
import type { Token } from '../contract/document';
import { flagsOf, kinds, modifiers } from '../contract/symbols';
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
