/** The symbol kinds. An engine writes the kind of a row or a token as its index in this list. */
export const kinds = [
    'namespace',
    'class',
    'struct',
    'interface',
    'enum',
    'delegate',
    'method',
    'constructor',
    'operator',
    'property',
    'indexer',
    'field',
    'enum_member',
    'event',
    'parameter',
    'local',
    'type_parameter',
    'label',
    'opcode',
    'record',
    'annotation',
    'section',
    'reference',
    'resource',
    'function',
    'variable',
] as const;

/**
 * The symbol modifiers, with `declaration` for the token that declares a symbol and `document` for a row that has its
 * own document. Each modifier of a symbol sets the flags' bit at the modifier's index in this list plus 4.
 */
export const modifiers = [
    'declaration',
    'document',
    'static',
    'abstract',
    'sealed',
    'virtual',
    'override',
    'readonly',
    'const',
    'extern',
    'extension',
    'final',
    'synchronized',
    'native',
    'transient',
    'volatile',
    'default',
] as const;

/**
 * The accessibilities, where the empty text is for a symbol without an accessibility. An engine writes the index into
 * the flags' bits 0 to 3.
 */
export const accessibilities = [
    '',
    'private',
    'private protected',
    'protected',
    'internal',
    'protected internal',
    'public',
    'package-private',
] as const;

export type Kind = (typeof kinds)[number];
export type Modifier = (typeof modifiers)[number];
export type Accessibility = (typeof accessibilities)[number];

const accessibilityBits = 15;
/** The bit of a flags' first modifier, above the accessibility's bits. */
export const modifierShift = 4;

/** Packs an accessibility and modifiers into the flags of a row or a token. */
export function flagsOf(accessibility: Accessibility, ...symbolModifiers: Modifier[]): number {
    let flags = accessibilities.indexOf(accessibility);
    for (const modifier of symbolModifiers) {
        flags |= 1 << (modifiers.indexOf(modifier) + modifierShift);
    }

    return flags;
}

export function accessibilityOf(flags: number): Accessibility {
    return accessibilities[flags & accessibilityBits] ?? '';
}

/** Checks 1 modifier of a row's or a token's flags without listing the others. */
export function hasModifier(flags: number, modifier: Modifier): boolean {
    return (flags & (1 << (modifiers.indexOf(modifier) + modifierShift))) !== 0;
}

export function modifiersOf(flags: number): Modifier[] {
    return modifiers.filter((_, bit) => (flags & (1 << (bit + modifierShift))) !== 0);
}
