import { expect, test } from 'bun:test';
import { accessibilities, accessibilityOf, flagsOf, hasModifier, kinds, modifiers, modifiersOf } from './symbols';

test('each kind, modifier and accessibility has its own name', () => {
    for (const names of [kinds, modifiers, accessibilities]) {
        expect(new Set(names).size).toBe(names.length);
    }
});

test('kinds, accessibilities and modifiers keep the numbers that the engines write', () => {
    expect(kinds).toEqual([
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
    ]);
    expect(accessibilities).toEqual([
        '',
        'private',
        'private protected',
        'protected',
        'internal',
        'protected internal',
        'public',
        'package-private',
    ]);
    expect(flagsOf('public')).toBe(6);
    expect(flagsOf('package-private')).toBe(7);
    expect(modifiers).toEqual([
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
    ]);
    expect(modifiers.map(modifier => flagsOf('', modifier))).toEqual([
        16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
    ]);
});

test('flags give back their accessibility and their modifiers', () => {
    const flags = flagsOf('protected internal', 'static', 'readonly');

    expect(accessibilityOf(flags)).toBe('protected internal');
    expect(modifiersOf(flags)).toEqual(['static', 'readonly']);
});

test('flags of every modifier leave the accessibility empty', () => {
    expect(accessibilityOf(flagsOf('', ...modifiers))).toBe('');
});

test('hasModifier finds each modifier of the flags and no other', () => {
    const flags = flagsOf('public', 'document', 'default');

    expect(modifiers.filter(modifier => hasModifier(flags, modifier))).toEqual(['document', 'default']);
    expect(hasModifier(flagsOf('public'), 'declaration')).toBe(false);
});
