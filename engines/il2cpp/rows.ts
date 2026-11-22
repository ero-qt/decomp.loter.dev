import type { Row } from '#contract/rows';
import { type Accessibility, flagsOf, type Kind, type Modifier } from '#contract/symbols';
import type { Game, GameField, GameMethod, GameType } from './game';

/**
 * The first key of each kind of row. A type's key is its index. A member's key is its kind's first key plus the
 * member's index among all members of that kind in the metadata. The row of the game's binary has the key `binary`.
 */
export const firstKeys = {
    field: 0x10000000,
    method: 0x20000000,
    property: 0x30000000,
    image: 0x40000000,
    namespace: 0x48000000,
    binary: 0x4f000000,
};

/**
 * Returns the key of a function or a global of the game's binary by its address relative to the image, which only a
 * body's C# names, like a function of the runtime. The key has the top bit of its 32 bits set, which no row's key has.
 */
export function writeBinaryKey(rva: number): number {
    return rva | 0x80000000;
}

/** Returns the address relative to the image of a key of `writeBinaryKey`, or `undefined` for a row's key. */
export function readBinaryKey(key: number): number | undefined {
    return key < 0 ? key & 0x7fffffff : undefined;
}

// the visibilities of ECMA-335 II.23.1.15 and II.23.1.10 in their order, for a type and for a member
const typeAccessibilities: Accessibility[] = [
    'internal',
    'public',
    'public',
    'private',
    'protected',
    'internal',
    'private protected',
    'protected internal',
];
const memberAccessibilities: Accessibility[] = ['', 'private', 'private protected', 'internal', 'protected', 'protected internal', 'public'];

// the most types that the engine finds around a nested type
const maxNesting = 64;

/** The flags of types, methods and fields of ECMA-335 II.23.1.15, II.23.1.10 and II.23.1.5 that the engine reads. */
export const typeFlags = { visibility: 0x7, interface: 0x20, abstract: 0x80, sealed: 0x100 };
export const methodFlags = { access: 0x7, static: 0x10, virtual: 0x40, newSlot: 0x100, abstract: 0x400 };
export const fieldFlags = { access: 0x7, static: 0x10, initOnly: 0x20, literal: 0x40 };

/** Returns a name without the count of generic parameters after its backtick, like `List` for `List`1`. */
export function stripArity(name: string): string {
    return name.replace(/`\d+$/, '');
}

/** The indexes of the first field, method and property of each type among all members of their kind. */
export interface MemberStarts {
    fields: number[];
    methods: number[];
    properties: number[];
}

/** Counts the members before each type, which a member's key adds its index in its type to. */
export function countMemberStarts(game: Game): MemberStarts {
    const starts: MemberStarts = { fields: [], methods: [], properties: [] };
    const totals = { fields: 0, methods: 0, properties: 0 };
    for (const type of game.types) {
        for (const kind of ['fields', 'methods', 'properties'] as const) {
            starts[kind].push(totals[kind]);
            totals[kind] += type[kind].length;
        }
    }

    return starts;
}

/** A method with code, with its row's key and the index of its type. */
export interface CodeMethod {
    key: number;
    typeIndex: number;
}

/**
 * Indexes the methods with code by the address of their code that `findCode` gives, with `null` at an address that
 * several methods share, like the empty methods that MSVC's identical code folding merges, because a call of that code
 * can mean any of them.
 */
export function indexCodeMethods(game: Game, starts: MemberStarts, findCode: (rva: number) => number): Map<number, CodeMethod | null> {
    const methods = new Map<number, CodeMethod | null>();
    game.types.forEach((type, typeIndex) => {
        type.methods.forEach(({ rva }, index) => {
            if (rva !== null) {
                const code = findCode(rva);
                methods.set(code, methods.has(code) ? null : { key: firstKeys.method + starts.methods[typeIndex] + index, typeIndex });
            }
        });
    });

    return methods;
}

/** Returns a type's name with its generic parameters in place of the backtick and count, like `List<T>`. */
export function formatTypeName(type: GameType): string {
    const name = stripArity(type.name);

    return type.genericParameters.length > 0 ? `${name}<${type.genericParameters.join(', ')}>` : name;
}

/**
 * Returns the types that contain a nested type, outermost first, up to `maxNesting` of them, because crafted metadata
 * can nest a type in itself.
 */
export function listOuterTypes(game: Game, typeIndex: number): GameType[] {
    const outerTypes: GameType[] = [];
    for (let outer = game.types[typeIndex].declaringType; outer >= 0 && outerTypes.length < maxNesting; outer = game.types[outer].declaringType) {
        outerTypes.push(game.types[outer]);
    }

    return outerTypes.reverse();
}

/** Returns a type's name after its namespace and outer types, like `Shapes.Circle.Builder`. */
export function formatFullName(game: Game, typeIndex: number): string {
    const outerTypes = listOuterTypes(game, typeIndex);
    const type = game.types[typeIndex];
    const namespace = (outerTypes[0] ?? type).namespace;
    const names = [...outerTypes, type].map(formatTypeName).join('.');

    return namespace === '' ? names : `${namespace}.${names}`;
}

// returns whether a type is the `<Module>` type that each image has for its global members, which C# doesn't show
function isModuleType(type: GameType): boolean {
    return type.name === '<Module>' && type.namespace === '';
}

function findTypeKind(type: GameType): Kind {
    if ((type.flags & typeFlags.interface) !== 0) {
        return 'interface';
    }
    if (type.isEnum) {
        return 'enum';
    }

    return type.isValueType ? 'struct' : 'class';
}

function findTypeFlags(type: GameType, kind: Kind): number {
    const modifiers: Modifier[] = ['document'];
    const isAbstract = (type.flags & typeFlags.abstract) !== 0;
    const isSealed = (type.flags & typeFlags.sealed) !== 0;
    if (kind === 'class') {
        if (isAbstract && isSealed) {
            modifiers.push('static');
        } else if (isAbstract) {
            modifiers.push('abstract');
        } else if (isSealed) {
            modifiers.push('sealed');
        }
    }

    return flagsOf(typeAccessibilities[type.flags & typeFlags.visibility], ...modifiers);
}

/** Returns the modifiers of a method from its flags, with `override` for a virtual method that doesn't start a slot. */
function findMethodModifiers({ flags }: GameMethod): Modifier[] {
    const modifiers: Modifier[] = [];
    if ((flags & methodFlags.static) !== 0) {
        modifiers.push('static');
    }
    if ((flags & methodFlags.abstract) !== 0) {
        modifiers.push('abstract');
    } else if ((flags & methodFlags.virtual) !== 0) {
        modifiers.push((flags & methodFlags.newSlot) !== 0 ? 'virtual' : 'override');
    }

    return modifiers;
}

/** Returns a field's flags for its row, or 0 without the binary, which has the field's flags. */
function findFieldFlags({ flags }: GameField): number {
    if (flags === null) {
        return 0;
    }

    const modifiers: Modifier[] = [];
    if ((flags & fieldFlags.literal) !== 0) {
        modifiers.push('const');
    } else if ((flags & fieldFlags.static) !== 0) {
        modifiers.push('static');
    }
    if ((flags & fieldFlags.initOnly) !== 0) {
        modifiers.push('readonly');
    }

    return flagsOf(memberAccessibilities[flags & fieldFlags.access] ?? '', ...modifiers);
}

function findMethodAccessibility({ flags }: GameMethod): Accessibility {
    return memberAccessibilities[flags & methodFlags.access] ?? '';
}

/** Returns whether a method is an instance or a static constructor. */
export function isConstructor(method: GameMethod): boolean {
    return method.name === '.ctor' || method.name === '.cctor';
}

function formatMethodName(type: GameType, method: GameMethod): string {
    const name = isConstructor(method) ? stripArity(type.name) : method.name;
    const generics = method.genericParameters.length > 0 ? `<${method.genericParameters.join(', ')}>` : '';

    const parameters = method.parameters.map(parameter => parameter.type?.name ?? parameter.name);

    return `${name}${generics}(${parameters.join(', ')})`;
}

/**
 * Lists a game's rows. An image's row is above its namespaces and its types without a namespace. A type's row is above
 * its members and its nested types. A property's row is above its accessors, like in the .NET engine's rows.
 */
export function listRows(game: Game): Row[] {
    const rows: Row[] = [];
    const starts = countMemberStarts(game);
    const nestedTypes = Map.groupBy(game.types.keys(), index => game.types[index].declaringType);

    function byName(first: number, second: number): number {
        return formatTypeName(game.types[first]).localeCompare(formatTypeName(game.types[second]));
    }

    function addRow(kind: Kind, flags: number, parent: number, key: number, name: string, detail = ''): number {
        rows.push({ kind, flags, parent, key, name, detail, hiddenViews: 0 });

        return rows.length - 1;
    }

    function addType(typeIndex: number, parent: number) {
        const type = game.types[typeIndex];
        const kind = findTypeKind(type);
        const row = addRow(kind, findTypeFlags(type, kind), parent, typeIndex, formatTypeName(type));

        // leaves out an enum's value field because C# only shows the enum's constants
        type.fields.forEach((field, index) => {
            if (kind === 'enum' && field.name === 'value__') {
                return;
            }

            const fieldKind = kind === 'enum' ? 'enum_member' : 'field';
            addRow(fieldKind, findFieldFlags(field), row, firstKeys.field + starts.fields[typeIndex] + index, field.name, field.value ?? '');
        });

        function addMethod(index: number, parent: number) {
            const method = type.methods[index];
            const flags = flagsOf(findMethodAccessibility(method), ...findMethodModifiers(method));
            const key = firstKeys.method + starts.methods[typeIndex] + index;
            const address = method.rva === null ? '' : `0x${method.rva.toString(16)}`;
            addRow(isConstructor(method) ? 'constructor' : 'method', flags, parent, key, formatMethodName(type, method), address);
        }

        // keeps each accessor for the row of its first property, because crafted metadata can give 2 properties 1 method
        const accessors = new Set(type.properties.flatMap(({ getter, setter }) => [getter, setter]).filter(index => type.methods[index]));
        for (const index of type.methods.keys()) {
            if (!accessors.has(index)) {
                addMethod(index, row);
            }
        }

        type.properties.forEach((property, index) => {
            const accessor = type.methods[property.getter >= 0 ? property.getter : property.setter];
            const flags = accessor === undefined ? 0 : flagsOf(findMethodAccessibility(accessor), ...findMethodModifiers(accessor));
            const propertyRow = addRow('property', flags, row, firstKeys.property + starts.properties[typeIndex] + index, property.name);

            for (const accessorIndex of [property.getter, property.setter]) {
                if (accessors.delete(accessorIndex)) {
                    addMethod(accessorIndex, propertyRow);
                }
            }
        });

        for (const nested of (nestedTypes.get(typeIndex) ?? []).sort(byName)) {
            addType(nested, row);
        }
    }

    let namespaceCount = 0;
    game.images.forEach((image, imageIndex) => {
        const imageRow = addRow('section', 0, -1, firstKeys.image + imageIndex, image.name);
        const topTypes = Array.from({ length: image.typeCount }, (_, offset) => image.firstType + offset)
            .filter(index => game.types[index].declaringType < 0 && !isModuleType(game.types[index]));
        const typesByNamespace = Map.groupBy(topTypes, index => game.types[index].namespace);

        for (const namespace of [...typesByNamespace.keys()].sort()) {
            const parent = namespace === '' ? imageRow : addRow('namespace', 0, imageRow, firstKeys.namespace + namespaceCount++, namespace);
            for (const typeIndex of typesByNamespace.get(namespace)!.sort(byName)) {
                addType(typeIndex, parent);
            }
        }
    });

    return rows;
}
