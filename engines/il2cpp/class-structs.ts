import { cleanName, type CTypes, isStaticField, measureCType, writeMembers } from './c-types';
import { type GameClass, type GameField, globalKinds, rgctxKinds } from './game';

/**
 * The functions that write the C structs of the classes that the binary's TypeInfo globals point to by the structs'
 * names, and each global's C type by its type.
 */
export interface ClassStructs {
    structs: Map<string, () => string>;
    /** The C type of a TypeInfo global by its type definition's index, like `struct Debug_c *`. */
    pointerTypes: Map<number, string>;
    /** The name of the struct of a type's static fields by the type definition's index, like `Debug_StaticFields`. */
    staticStructs: Map<number, string>;
    /**
     * The structs of the static fields of generic types' instances by their names, like `Singleton_Circle__StaticFields`,
     * with the generic type's index, the instance's C# name and the fields at their offsets.
     */
    instanceStatics: Map<string, { typeIndex: number; csharpName: string; fields: () => GameField[] }>;
    /** The C type of a TypeInfo global of a generic type's instance by the index of its class among the game's classes. */
    classPointerTypes: Map<number, string>;
    /** The C type of a generic type's method's global by the index of its class among the game's classes. */
    methodPointerTypes: Map<number, string>;
    /** The names of the structs of the runtime's metadata, of the classes, their runtime generic contexts and methods. */
    metadataStructs: Set<string>;
}

/** The struct of an `Il2CppClass` without a type's static fields, which a TypeInfo global of a generic type gets. */
export const plainClassStruct = 'Il2CppClass';

// the layout from which `Il2CppClass` has `unity_user_data` before the static constructor's state, the layout from
// which `genericContainerIndex` became a handle, the layout from which `MethodInfo` has `virtualMethodPointer` and the
// layout of Unity 2022.2 and later, whose `Il2CppClass` has `stack_slot_size` and doesn't have `naturalAligment`
const userDataLayout = 24.1;
const handleLayout = 27;
const virtualPointerLayout = 29;
const stackSlotLayout = 31;

// the members of `Il2CppClass` up to `static_fields`, which take 23 pointers, `byval_arg` and `this_arg` 2 each
const leadingPointers = ['image', 'gc_desc', 'name', 'namespaze'];
const middlePointers = ['element_class', 'castClass', 'declaringType', 'parent', 'generic_class', 'typeMetadataHandle', 'interopData', 'klass'];
const tablePointers = ['fields', 'events', 'properties', 'methods', 'nestedTypes', 'implementedInterfaces', 'interfaceOffsets'];

// lists the members after `cctor_thread` until the bit fields, whose first bit is `initialized_and_no_error`
function listTailMembers(layout: number): string[] {
    const sizes = ['instance_size', ...(layout >= stackSlotLayout ? ['stack_slot_size'] : []), 'actualSize', 'element_size', 'native_size'];
    const fieldSizes = ['static_fields_size', 'thread_static_fields_size', 'thread_static_fields_offset'];
    const alignments = ['minimumAlignment', ...(layout >= stackSlotLayout ? [] : ['naturalAligment']), 'packingSize'];

    return [
        layout >= handleLayout ? 'void *genericContainerHandle' : 'int32_t genericContainerIndex',
        ...[...sizes, ...fieldSizes, 'flags', 'token'].map(name => `uint32_t ${name}`),
        ...['method_count', 'property_count', 'field_count', 'event_count', 'nested_type_count', 'vtable_count'].map(name => `uint16_t ${name}`),
        ...['interfaces_count', 'interface_offsets_count'].map(name => `uint16_t ${name}`),
        ...['typeHierarchyDepth', 'genericRecursionDepth', 'rank', ...alignments].map(name => `uint8_t ${name}`),
        'uint8_t bitflags1',
        'uint8_t bitflags2',
    ];
}

/**
 * Writes the members of `Il2CppClass` with `staticFields` as the type of `static_fields`, like Il2CppDumper's `_c`
 * structs, with the static constructor's state from layout 24.1.
 */
function writeClassMembers(types: CTypes, staticFields: string, rgctx = 'void'): string[] {
    const pointer = (name: string) => `    void *${name};`;
    const size = `uint${types.pointerSize * 8}_t`;
    const layout = Number(types.game.layout);
    const members = [
        ...leadingPointers.map(pointer),
        `    uint8_t byval_arg[${types.pointerSize * 2}];`,
        `    uint8_t this_arg[${types.pointerSize * 2}];`,
        ...middlePointers.map(pointer),
        ...tablePointers.map(pointer),
        `    ${staticFields} *static_fields;`,
        `    ${rgctx} *rgctx_data;`,
        pointer('typeHierarchy'),
    ];
    if (layout < userDataLayout) {
        return members;
    }

    members.push(
        pointer('unity_user_data'),
        '    uint32_t initializationExceptionGCHandle;',
        '    uint32_t cctor_started;',
        '    uint32_t cctor_finished;',
    );

    // aligns `cctor_thread` to 8 bytes, like IL2CPP's `ALIGN_TYPE(8)`
    const cctorThread = types.pointerSize * 27 + 12;
    if (cctorThread % 8 !== 0) {
        members.push(`    uint8_t _gap_${cctorThread.toString(16)}[${8 - (cctorThread % 8)}];`);
    }

    return [...members, `    ${size} cctor_thread;`, ...listTailMembers(layout).map(member => `    ${member};`)];
}

/** The struct of IL2CPP's `MethodInfo`, which a method's global points to. */
export const methodStruct = 'MethodInfo';

/**
 * Writes a struct of `MethodInfo` up to the method's generic data, with `klass` of a C type after the method's pointers.
 */
function writeMethodStruct(types: CTypes, klass: string, name = methodStruct): string {
    const layout = Number(types.game.layout);
    const pointers = ['methodPointer', ...(layout >= virtualPointerLayout ? ['virtualMethodPointer'] : []), 'invoker_method', 'name'];
    const members = [
        ...pointers.map(name => `void *${name}`),
        `${klass}klass`,
        ...['return_type', 'parameters', 'rgctx_data', 'genericMethod'].map(name => `void *${name}`),
    ];

    return `struct ${name} {\n${members.map(member => `    ${member};\n`).join('')}};\n`;
}

// gives each type's structs the name of its class struct without `_o`, with the type's index after a name that 2
// types have
function nameBase(types: CTypes, typeIndex: number, counts: Map<string, number>): string {
    const structName = types.structNames.get(typeIndex);
    const name = cleanName(types.game.types[typeIndex].name);

    return structName?.slice(0, -2) ?? (counts.get(name) === 1 ? name : `${name}_${typeIndex}`);
}

// lists the static fields of a generic type's instance with the arguments' types, at the offsets that the runtime gives
// them in their order with each field aligned to its size, because the binary only has the offsets of the shared
// instance. Stops before a field of unknown size.
function listInstanceStatics(types: CTypes, { definition, typeArguments }: GameClass): GameField[] {
    const { genericParameters, fields } = types.game.types[definition];
    const statics: GameField[] = [];
    let end = 0;
    for (const field of fields.filter(isStaticField)) {
        const parameter = genericParameters.indexOf(field.type?.name ?? '');
        const type = parameter >= 0 ? (typeArguments[parameter] ?? null) : field.type;
        const size = measureCType(types, type);
        if (size === undefined) {
            break;
        }

        const offset = Math.ceil(end / size) * size;
        statics.push({ ...field, type, offset });
        end = offset + size;
    }

    return statics;
}

// writes the struct of a class's static fields with a byte after the fields, because the decompiler reads the field of a
// struct of 1 field as the whole struct
function writeStaticStruct(types: CTypes, name: string, fields: GameField[]): string {
    const members = fields.length > 0 ? writeMembers(types, fields, 0) : [];

    return `struct ${name} {\n${[...members, '    uint8_t _end;'].join('\n')}\n};\n`;
}

/**
 * Lists an `Il2CppClass` struct and a `_c` struct with a `_StaticFields` struct for each type that a TypeInfo global
 * of the binary points to, like Il2CppDumper's `il2cpp.h`. A global of an array gets the plain `Il2CppClass`. Each class
 * that the globals reach gets its structs too, a generic type's instance with the arguments' types in its static fields
 * and a struct of its runtime generic context, whose entries have their classes' structs, and a `MethodInfo` of its
 * methods whose `klass` points to the class's struct.
 */
export function listClassStructs(types: CTypes): ClassStructs {
    const { game } = types;
    const counts = new Map<string, number>();
    for (const type of game.types) {
        counts.set(cleanName(type.name), (counts.get(cleanName(type.name)) ?? 0) + 1);
    }

    const pointerTypes = new Map<number, string>();
    const staticStructs = new Map<number, string>();
    const instanceStatics = new Map<string, { typeIndex: number; csharpName: string; fields: () => GameField[] }>();
    const classPointerTypes = new Map<number, string>();
    const methodPointerTypes = new Map<number, string>();
    const structs = new Map([
        [plainClassStruct, () => `struct ${plainClassStruct} {\n${writeClassMembers(types, 'void').join('\n')}\n};\n`],
        [methodStruct, () => writeMethodStruct(types, `struct ${plainClassStruct} *`)],
    ]);

    // adds the structs of a type definition's class, with the static fields at their offsets in the binary
    function addDefinition(typeIndex: number): string {
        const base = nameBase(types, typeIndex, counts);
        if (!pointerTypes.has(typeIndex)) {
            const byOffset = (first: GameField, second: GameField) => first.offset! - second.offset!;
            const listFields = () => game.types[typeIndex].fields.filter(isStaticField).sort(byOffset);
            structs.set(`${base}_StaticFields`, () => writeStaticStruct(types, `${base}_StaticFields`, listFields()));
            structs.set(`${base}_c`, () => `struct ${base}_c {\n${writeClassMembers(types, `struct ${base}_StaticFields`).join('\n')}\n};\n`);
            pointerTypes.set(typeIndex, `struct ${base}_c *`);
            staticStructs.set(typeIndex, `${base}_StaticFields`);
        }

        return base;
    }

    for (const global of game.globals) {
        const type = game.types[global.definition];
        // leaves out a generic type's instance, an array and a pointer, whose C# names have these characters
        const isPlain = type !== undefined && !/[<[*]/.test(global.name);
        if (global.kind === globalKinds.typeInfo && isPlain) {
            addDefinition(global.definition);
        }
    }

    const classCounts = new Map<string, number>();
    for (const { text } of game.classes) {
        classCounts.set(cleanName(text), (classCounts.get(cleanName(text)) ?? 0) + 1);
    }

    const instanceBase = (text: string, index: number) => (classCounts.get(cleanName(text)) === 1 ? cleanName(text) : `${cleanName(text)}_${index}`);
    const bases = game.classes.map(({ text, definition, typeArguments }, index) => {
        const isDefinition = typeArguments.length === 0 && game.types[definition]?.genericParameters.length === 0;

        return game.types[definition] === undefined ? undefined : isDefinition ? addDefinition(definition) : instanceBase(text, index);
    });
    const classPointer = (index: number) => (bases[index] === undefined ? `struct ${plainClassStruct} *` : `struct ${bases[index]}_c *`);

    game.classes.forEach((gameClass, index) => {
        const base = bases[index];
        if (base === undefined) {
            return;
        }

        classPointerTypes.set(index, classPointer(index));
        methodPointerTypes.set(index, `struct ${base}_MethodInfo *`);
        structs.set(`${base}_MethodInfo`, () => writeMethodStruct(types, classPointer(index), `${base}_MethodInfo`));
        if (pointerTypes.get(gameClass.definition) === classPointer(index)) {
            return;
        }

        const rgctx = gameClass.rgctx.length > 0 ? `struct ${base}_RGCTXs` : 'void';
        const fields = () => listInstanceStatics(types, gameClass);
        structs.set(`${base}_StaticFields`, () => writeStaticStruct(types, `${base}_StaticFields`, fields()));
        structs.set(`${base}_RGCTXs`, () => writeRgctxStruct(`${base}_RGCTXs`, gameClass, classPointer));
        structs.set(`${base}_c`, () => `struct ${base}_c {\n${writeClassMembers(types, `struct ${base}_StaticFields`, rgctx).join('\n')}\n};\n`);
        instanceStatics.set(`${base}_StaticFields`, { typeIndex: gameClass.definition, csharpName: gameClass.text, fields });
    });

    const metadataStructs = new Set([...structs.keys()].filter(name => !name.endsWith('_StaticFields')));

    return { structs, pointerTypes, staticStructs, instanceStatics, classPointerTypes, methodPointerTypes, metadataStructs };
}

// writes the struct of a class's runtime generic context, whose entries are pointers, a class's entry to its class's
// struct and a method's entry to IL2CPP's `MethodInfo`. A byte follows the entries, because the decompiler reads the
// entry of a struct of 1 entry as the whole struct.
function writeRgctxStruct(name: string, { rgctx }: GameClass, classPointer: (index: number) => string): string {
    const members = rgctx.map(({ kind, class: index }, entry) => {
        const isClass = kind === rgctxKinds.class || kind === rgctxKinds.array;
        const cType = isClass ? classPointer(index) : kind === rgctxKinds.method ? `struct ${methodStruct} *` : 'void *';

        return `    ${cType}rgctx_${entry};\n`;
    });

    return `struct ${name} {\n${members.join('')}    uint8_t _end;\n};\n`;
}
