import type { Game, GameField, GameMethod, GameType, TypeReference } from './game';
import { fieldFlags, methodFlags, stripArity, typeFlags } from './rows';


// the C types of C#'s built-in value types, with their sizes in bytes
const builtInTypes: Record<string, [cType: string, size: number]> = {
    bool: ['bool', 1],
    byte: ['uint8_t', 1],
    sbyte: ['int8_t', 1],
    char: ['char16_t', 2],
    short: ['int16_t', 2],
    ushort: ['uint16_t', 2],
    int: ['int32_t', 4],
    uint: ['uint32_t', 4],
    long: ['int64_t', 8],
    ulong: ['uint64_t', 8],
    float: ['float', 4],
    double: ['double', 8],
};

// the words that C reserves, which a parameter's name can't be
const cKeywords = new Set(
    ('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict ' +
        'return short signed sizeof static struct switch typedef union unsigned void volatile while').split(' '),
);

/** The C names of a game's class structs and the pointer size of its binary, which the header and signatures share. */
export interface CTypes {
    game: Game;
    pointerSize: number;
    /** The struct's name by its type's index, like `ArrayList_o`, for each class with a struct. */
    structNames: Map<number, string>;
    /** The structs of `System.String` and `System.Object` by C#'s keywords for them, `string` and `object`. */
    keywordStructs: Map<string, string>;
    /** The structs of the arrays that a signature or a field has by the structs' names, which `writeCType` fills. */
    arrayStructs: Map<string, ArrayStruct>;
}

/** The struct of an array's objects, with the array's C# name, like `int[]`, and the C type of its items. */
export interface ArrayStruct {
    csharpName: string;
    itemType: string;
}

/** The name of the member with an array's length, and the C# name of the length. */
export const arrayLength = { member: 'max_length', csharpName: 'Length' };

/** Turns a name into a C name, without the count of generic parameters, like `List` for `List`1`. */
export function cleanName(name: string): string {
    return stripArity(name).replace(/[^A-Za-z0-9_]/g, '_');
}

function hasStruct(type: GameType): boolean {
    return !type.isValueType && (type.flags & typeFlags.interface) === 0;
}

/**
 * Gives each class's struct the class's name, like `ArrayList_o` in Il2CppDumper's `il2cpp.h`, with the type's index
 * after a name that 2 classes have.
 */
export function nameStructs(game: Game, pointerSize: number): CTypes {
    const counts = new Map<string, number>();
    for (const type of game.types.filter(hasStruct)) {
        counts.set(cleanName(type.name), (counts.get(cleanName(type.name)) ?? 0) + 1);
    }

    const structNames = new Map<number, string>();
    game.types.forEach((type, index) => {
        if (hasStruct(type)) {
            const name = cleanName(type.name);
            structNames.set(index, counts.get(name) === 1 ? `${name}_o` : `${name}_${index}_o`);
        }
    });

    const keywordStructs = new Map<string, string>();
    game.types.forEach((type, index) => {
        const keyword = type.namespace === 'System' ? { String: 'string', Object: 'object' }[type.name] : undefined;
        if (keyword && structNames.has(index)) {
            keywordStructs.set(keyword, structNames.get(index)!);
        }
    });

    return { game, pointerSize, structNames, keywordStructs, arrayStructs: new Map() };
}

function declare(cType: string, name: string): string {
    return `${cType.endsWith('*') ? cType : `${cType} `}${name}`;
}

const arraySuffix = '[]';

/**
 * Names the struct of the objects of an array with 1 dimension, like `int_array` for `int[]`, with the index of the
 * items' type definition for a type that isn't built in, and keeps what the struct has. Returns `undefined` for an
 * array of structs of unknown size and for an array of a generic parameter, whose items' size depends on the argument.
 */
function useArrayStruct(types: CTypes, reference: TypeReference): string | undefined {
    const item = { name: reference.name.slice(0, -arraySuffix.length), definition: reference.definition };
    const [itemType] = writeCType(types, item) ?? [];
    const isKeyword = builtInTypes[item.name] !== undefined || types.keywordStructs.has(item.name);
    const isKnown = isKeyword || item.definition >= 0 || item.name.endsWith(arraySuffix);
    if (itemType === undefined || !isKnown) {
        return undefined;
    }

    const name = `${cleanName(item.name)}${isKeyword ? '' : `_${item.definition}`}_array`;
    types.arrayStructs.set(name, { csharpName: reference.name, itemType });

    return name;
}

/**
 * Writes the struct of an array's objects like IL2CPP's `Il2CppArray`, with the object's header, the bounds, the
 * length and the items. The length only has the low 4 bytes of `max_length`, because the code reads it as C#'s `int`.
 */
export function writeArrayStruct(types: CTypes, name: string, { itemType }: ArrayStruct): string {
    const lengthEnd = types.pointerSize * 3 + 4;
    const members = ['void *klass', 'void *monitor', 'void *bounds', `int32_t ${arrayLength.member}`];
    if (types.pointerSize === 8) {
        members.push(`uint8_t _gap_${lengthEnd.toString(16)}[4]`);
    }

    members.push(declare(itemType, 'items[1]'));

    return `struct ${name} {\n${members.map(member => `    ${member};\n`).join('')}};\n`;
}

// the text before the name of a type that a parameter takes by reference, like `ref bool`
const byReference = 'ref ';

// returns the C type and size of a type in a signature or a field, or undefined for a value type of unknown size
function writeCType(types: CTypes, reference: TypeReference | null): [cType: string, size: number] | undefined {
    const builtIn = reference && builtInTypes[reference.name];
    if (builtIn) {
        return builtIn;
    }
    // a parameter by reference takes a pointer to its type, so a local whose address a call passes gets the type
    if (reference?.name.startsWith(byReference)) {
        const [pointed] = writeCType(types, { ...reference, name: reference.name.slice(byReference.length) }) ?? ['void'];

        return [`${pointed.endsWith('*') ? pointed : `${pointed} `}*`, types.pointerSize];
    }
    if (reference?.name.endsWith(arraySuffix)) {
        const structName = useArrayStruct(types, reference);

        return [structName ? `struct ${structName} *` : 'void *', types.pointerSize];
    }
    // an array of several dimensions and a pointer take a pointer whatever their element, which `definition` points at
    if (reference?.name === 'IntPtr' || reference?.name === 'UIntPtr' || /[\]*]$/.test(reference?.name ?? '')) {
        return ['void *', types.pointerSize];
    }

    const definition = reference ? types.game.types[reference.definition] : undefined;
    if (definition?.isEnum) {
        return writeCType(types, definition.fields.find(field => field.name === 'value__')?.type ?? null);
    }
    if (definition?.isValueType) {
        return undefined;
    }

    const structName = reference === null ? undefined : (types.structNames.get(reference.definition) ?? types.keywordStructs.get(reference.name));

    return [structName ? `struct ${structName} *` : 'void *', types.pointerSize];
}

function isInstanceField(field: GameField): boolean {
    return field.offset !== null && field.offset >= 0 && ((field.flags ?? 0) & (fieldFlags.static | fieldFlags.literal)) === 0;
}

/**
 * Checks whether a field takes room in its class's static fields, which a thread static field with offset -1 doesn't.
 */
export function isStaticField(field: GameField): boolean {
    return field.offset !== null && field.offset >= 0 && ((field.flags ?? 0) & (fieldFlags.static | fieldFlags.literal)) === fieldFlags.static;
}

/** Lists the instance fields of a class and of its base classes by their offsets. */
export function listInstanceFields(game: Game, typeIndex: number): GameField[] {
    const fields: GameField[] = [];
    const seen = new Set<number>();
    for (let index = typeIndex; index >= 0 && !seen.has(index); index = game.types[index].baseType?.definition ?? -1) {
        seen.add(index);
        fields.push(...game.types[index].fields.filter(isInstanceField));
    }

    return fields.sort((first, second) => first.offset! - second.offset!);
}

// turns a field's name into a member's name that C takes and that the struct's other members don't have, because a
// C# field can be called like a C keyword and a class can repeat its base class's field
function cleanMemberName(name: string, names: Set<string>): string {
    const cleaned = cleanName(name) || 'field';
    const allowed = cKeywords.has(cleaned) || /^\d/.test(cleaned) ? `${cleaned}_` : cleaned;
    let unique = allowed;
    for (let count = 2; names.has(unique); count++) {
        unique = `${allowed}_${count}`;
    }

    names.add(unique);

    return unique;
}

/** Gives each field the name of its member in a struct of `writeMembers`, by the members' names. */
export function nameMembers(fields: GameField[]): Map<string, GameField> {
    const names = new Set(['klass', 'monitor']);

    return new Map(fields.map(field => [cleanMemberName(field.name, names), field]));
}

/**
 * Measures a struct from its first field's offset to its last field's end, or returns `undefined` for a struct without
 * fields and with a field of unknown size. `measuring` has the structs that contain it, because crafted metadata can
 * nest a struct in itself.
 */
function measureStruct(types: CTypes, reference: TypeReference | null, measuring = new Set<number>()): number | undefined {
    const definition = reference ? types.game.types[reference.definition] : undefined;
    if (!definition?.isValueType || measuring.has(reference!.definition)) {
        return undefined;
    }

    measuring.add(reference!.definition);
    const fields = definition.fields.filter(isInstanceField).sort((first, second) => first.offset! - second.offset!);
    const ends = fields.map(field => field.offset! + (writeCType(types, field.type)?.[1] ?? measureStruct(types, field.type, measuring) ?? NaN));
    measuring.delete(reference!.definition);

    const size = Math.max(...ends) - (fields[0]?.offset ?? 0);

    return Number.isFinite(size) && size > 0 ? size : undefined;
}

/**
 * Writes the members of a struct with each field at its offset from `start`. Bytes fill the space between 2 fields,
 * and a field that overlaps the field before it stays out, because a C struct can't have overlapping members.
 */
export function writeMembers(types: CTypes, fields: GameField[], start: number): string[] {
    const members: string[] = [];
    const names = new Set(['klass', 'monitor']);
    let end = start;
    fields.forEach((field, index) => {
        if (field.offset! < end) {
            return;
        }
        if (field.offset! > end) {
            members.push(`    uint8_t _gap_${end.toString(16)}[${field.offset! - end}];`);
        }

        const next = fields[index + 1]?.offset ?? field.offset! + types.pointerSize;
        const [cType, size] = writeCType(types, field.type) ?? [undefined, measureStruct(types, field.type) ?? Math.max(1, next - field.offset!)];
        const name = cleanMemberName(field.name, names);
        members.push(cType ? `    ${cType.endsWith('*') ? cType : `${cType} `}${name};` : `    uint8_t ${name}[${size}];`);
        end = field.offset! + size;
    });

    return members;
}

// writes a class's struct with the object's header and each instance field at its offset
function writeStruct(types: CTypes, typeIndex: number, structName: string): string {
    const fields = listInstanceFields(types.game, typeIndex);
    const members = ['    void *klass;', '    void *monitor;', ...writeMembers(types, fields, types.pointerSize * 2)];

    return `struct ${structName} {\n${members.join('\n')}\n};\n`;
}

/**
 * Returns the function that writes the C struct of each of a game's classes by the struct's name, with the class's
 * fields at their offsets, like Il2CppDumper's `il2cpp.h`.
 */
export function listStructs(types: CTypes): Map<string, () => string> {
    return new Map([...types.structNames].map(([typeIndex, structName]) => [structName, () => writeStruct(types, typeIndex, structName)]));
}

function cleanParameterName(name: string, index: number): string {
    const cleaned = cleanName(name) || `arg${index}`;

    return cKeywords.has(cleaned) || cleaned === 'method' || cleaned === '__this' || /^\d/.test(cleaned) ? `${cleaned}_` : cleaned;
}

/** The C types and names of a method's signature, as IL2CPP compiles the method. */
interface Signature {
    returnType: string;
    parameters: { cType: string; name: string }[];
}

// lists a method's return type and parameters, with `__this` first for an instance method and the method's
// `MethodInfo` pointer last. A struct by value becomes a pointer.
function readSignature(types: CTypes, typeIndex: number, method: GameMethod): Signature {
    const structName = types.structNames.get(typeIndex);
    const self = { cType: structName ? `struct ${structName} *` : 'void *', name: '__this' };
    const parameters = method.parameters.map((parameter, index) => ({
        cType: writeCType(types, parameter.type)?.[0] ?? 'void *',
        name: cleanParameterName(parameter.name, index),
    }));
    const isStatic = (method.flags & methodFlags.static) !== 0;
    const returnType = method.returnType?.name === 'void' ? 'void' : (writeCType(types, method.returnType)?.[0] ?? 'void *');

    return { returnType, parameters: [...(isStatic ? [] : [self]), ...parameters, { cType: 'void *', name: 'method' }] };
}

function formatSignature({ returnType, parameters }: Signature, name: string): string {
    return `${declare(returnType, cleanName(name))}(${parameters.map(({ cType, name }) => declare(cType, name)).join(', ')})`;
}

/**
 * Writes a method's C signature as IL2CPP compiles it, with `__this` first for an instance method and the method's
 * `MethodInfo` pointer last, like Il2CppDumper's `script.json`. A struct by value becomes a pointer.
 */
export function writeSignature(types: CTypes, typeIndex: number, method: GameMethod): string {
    return formatSignature(readSignature(types, typeIndex, method), `${cleanName(types.game.types[typeIndex].name)}__${method.name}`);
}

// returns the type that the types of several methods agree on, `void *` for pointers to different structs, or
// `undefined` for types of different sizes
function mergeCTypes(cTypes: string[]): string | undefined {
    if (cTypes.every(cType => cType === cTypes[0])) {
        return cTypes[0];
    }

    return cTypes.every(cType => cType.endsWith('*')) ? 'void *' : undefined;
}

/**
 * Writes the C signature of code that several methods share, like the code of 2 getters that the linker folded into 1
 * function. Each parameter has the type that the methods agree on or `void *` for different classes, because the code
 * isn't 1 method's. Returns an empty text for methods that differ in their parameters' count or sizes.
 */
export function writeSharedSignature(types: CTypes, methods: { typeIndex: number; method: GameMethod }[], name: string): string {
    const signatures = methods.map(({ typeIndex, method }) => readSignature(types, typeIndex, method));
    const [first] = signatures;
    if (signatures.some(({ parameters }) => parameters.length !== first.parameters.length)) {
        return '';
    }

    const returnType = mergeCTypes(signatures.map(signature => signature.returnType));
    const parameters = first.parameters.map((parameter, index) => {
        const names = signatures.map(signature => signature.parameters[index].name);

        return {
            cType: mergeCTypes(signatures.map(signature => signature.parameters[index].cType)),
            name: names.every(name => name === parameter.name) ? parameter.name : `arg${index}`,
        };
    });
    if (returnType === undefined || parameters.some(({ cType }) => cType === undefined)) {
        return '';
    }

    return formatSignature({ returnType, parameters: parameters as Signature['parameters'] }, name);
}
