import type { Token } from '#contract/document';
import { type Kind, kinds, modifiers, modifierShift, modifiersOf } from '#contract/symbols';

// kind -> the kind's semantic token type
const tokenTypes: Record<Kind, string> = {
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
};

/**
 * The semantic token types that the site adds to the workbench's standard types, each with the standard type whose
 * color a theme uses when the theme doesn't color the site's type.
 */
export const ownTokenTypes = [
    { id: 'delegate', superType: 'class', description: 'A delegate type.' },
    { id: 'constructor', superType: 'method', description: 'A constructor.' },
    { id: 'operatorMethod', superType: 'method', description: 'An operator method, like the `+` of a type.' },
    { id: 'indexer', superType: 'property', description: 'An indexer.' },
    { id: 'field', superType: 'property', description: 'A field.' },
    { id: 'opcode', superType: 'keyword', description: 'An instruction.' },
    { id: 'record', superType: 'class', description: 'A record class.' },
    { id: 'annotation', superType: 'interface', description: 'An annotation type.' },
];

/**
 * The semantic token legend of every view, with each kind's type at the kind's index and the contract's modifiers in
 * their order.
 */
export const tokenLegend = {
    tokenTypes: kinds.map(kind => tokenTypes[kind]),
    tokenModifiers: [...modifiers],
};

/** Returns the bits of the legend's modifiers in a token's flags. */
export function readTokenModifiers(flags: number): number {
    return (flags >>> modifierShift) & ((1 << modifiers.length) - 1);
}

/**
 * Finds the token at an offset in a document's text, also at the offset right after the token's end. Of 2 tokens that
 * touch at the offset, returns the token with a target, or else the later token, because a cursor at the start of a
 * name belongs to the name.
 */
export function findToken(tokens: Token[], offset: number): Token | undefined {
    const touching = tokens.filter(token => token.start <= offset && offset <= token.start + token.length);

    return touching.findLast(token => token.target !== null) ?? touching.at(-1);
}

/** Finds the first token with the `declaration` modifier for each target of a document's tokens. */
export function findDeclarations(tokens: Token[]): Map<string, Token> {
    // target -> the target's declaration token
    const declarations = new Map<string, Token>();
    for (const token of tokens) {
        if (token.target !== null && !declarations.has(token.target) && modifiersOf(token.flags).includes('declaration')) {
            declarations.set(token.target, token);
        }
    }

    return declarations;
}
