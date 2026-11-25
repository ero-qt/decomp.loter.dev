import { type Accessibility, accessibilityOf, flagsOf, type Modifier, modifiersOf } from '#contract/symbols';

/**
 * The access flags of the class file format, where a method's `bridge` and `varargs` share bits with a field's
 * `volatile` and `transient`.
 */
export const access = {
    public: 0x1,
    private: 0x2,
    protected: 0x4,
    static: 0x8,
    final: 0x10,
    synchronized: 0x20,
    volatile: 0x40,
    bridge: 0x40,
    transient: 0x80,
    varargs: 0x80,
    native: 0x100,
    interface: 0x200,
    abstract: 0x400,
    synthetic: 0x1000,
    annotation: 0x2000,
    enum: 0x4000,
    module: 0x8000,
};

function readAccessibility(flags: number): Accessibility {
    if (flags & access.public) {
        return 'public';
    }
    if (flags & access.protected) {
        return 'protected';
    }

    return flags & access.private ? 'private' : 'package-private';
}

function pickModifiers(flags: number, bits: [bit: number, modifier: Modifier][]): Modifier[] {
    return bits.filter(([bit]) => (flags & bit) !== 0).map(([, modifier]) => modifier);
}

/** Returns a class row's flags, without `abstract` for an interface because Java code doesn't write it there. */
export function readClassFlags(flags: number, isSealed: boolean): number {
    const abstract = flags & access.interface ? 0 : access.abstract;
    const modifiers = pickModifiers(flags, [[access.static, 'static'], [abstract, 'abstract'], [access.final, 'final']]);

    return flagsOf(readAccessibility(flags), ...modifiers, ...(isSealed ? ['sealed' as const] : []));
}

/** Returns a field row's flags. */
export function readFieldFlags(flags: number): number {
    const bits: [number, Modifier][] = [
        [access.static, 'static'],
        [access.final, 'final'],
        [access.transient, 'transient'],
        [access.volatile, 'volatile'],
    ];

    return flagsOf(readAccessibility(flags), ...pickModifiers(flags, bits));
}

/**
 * Returns a method row's flags. An interface's method has `default` when it has a body and isn't static or private, and
 * doesn't have `abstract` because Java code doesn't write it there.
 */
export function readMethodFlags(flags: number, isInInterface: boolean, hasCode: boolean): number {
    const isDefault = isInInterface && hasCode && (flags & (access.static | access.private)) === 0;
    const bits: [number, Modifier][] = [
        [access.static, 'static'],
        [isInInterface ? 0 : access.abstract, 'abstract'],
        [access.final, 'final'],
        [access.synchronized, 'synchronized'],
        [access.native, 'native'],
    ];

    return flagsOf(readAccessibility(flags), ...pickModifiers(flags, bits), ...(isDefault ? ['default' as const] : []));
}

// the modifiers in the order that Java code writes them
const javaOrder: Modifier[] = ['abstract', 'default', 'static', 'final', 'sealed', 'transient', 'volatile', 'synchronized', 'native'];

/**
 * Writes a row's accessibility and modifiers the way Java code writes them, with a space after each and without the
 * left out ones.
 */
export function writeModifiers(flags: number, leftOut: Modifier[] = []): string {
    const accessibility = accessibilityOf(flags);
    const modifiers = modifiersOf(flags).filter(modifier => !leftOut.includes(modifier));
    const words = [accessibility === 'package-private' ? '' : accessibility, ...javaOrder.filter(modifier => modifiers.includes(modifier))];

    return words.filter(word => word !== '').map(word => `${word} `).join('');
}
