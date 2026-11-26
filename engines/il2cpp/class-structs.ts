import { cleanName, type CTypes, isStaticField, writeMembers } from './c-types';
import { globalKinds } from './game';

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
    const alignments = ['minimumAlignment', ...(layout >= stackSlotLayout ? [] : ['naturalAligment']), 'packingSize'];

    return [
        layout >= handleLayout ? 'void *genericContainerHandle' : 'int32_t genericContainerIndex',
        ...[...sizes, 'static_fields_size', 'thread_static_fields_size', 'thread_static_fields_offset', 'flags', 'token'].map(name => `uint32_t ${name}`),
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
function writeClassMembers(types: CTypes, staticFields: string): string[] {
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
        ...['rgctx_data', 'typeHierarchy'].map(pointer),
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

/** Writes the struct of `MethodInfo` up to the method's generic data, with `klass` after the method's pointers. */
function writeMethodStruct(types: CTypes): string {
    const layout = Number(types.game.layout);
    const pointers = ['methodPointer', ...(layout >= virtualPointerLayout ? ['virtualMethodPointer'] : []), 'invoker_method', 'name'];
    const members = [
        ...pointers.map(name => `void *${name}`),
        `struct ${plainClassStruct} *klass`,
        ...['return_type', 'parameters', 'rgctx_data', 'genericMethod'].map(name => `void *${name}`),
    ];

    return `struct ${methodStruct} {\n${members.map(member => `    ${member};\n`).join('')}};\n`;
}

// gives each type's structs the name of its class struct without `_o`, with the type's index after a name that 2
// types have
function nameBase(types: CTypes, typeIndex: number, counts: Map<string, number>): string {
    const structName = types.structNames.get(typeIndex);
    const name = cleanName(types.game.types[typeIndex].name);

    return structName?.slice(0, -2) ?? (counts.get(name) === 1 ? name : `${name}_${typeIndex}`);
}

/**
 * Lists an `Il2CppClass` struct and a `_c` struct with a `_StaticFields` struct for each type that a TypeInfo global
 * of the binary points to, like Il2CppDumper's `il2cpp.h`. A global of a generic type or of an array gets the plain
 * `Il2CppClass`, because the static fields of a generic type depend on its arguments.
 */
export function listClassStructs(types: CTypes): ClassStructs {
    const { game } = types;
    const counts = new Map<string, number>();
    for (const type of game.types) {
        counts.set(cleanName(type.name), (counts.get(cleanName(type.name)) ?? 0) + 1);
    }

    const pointerTypes = new Map<number, string>();
    const staticStructs = new Map<number, string>();
    const structs = new Map([
        [plainClassStruct, () => `struct ${plainClassStruct} {\n${writeClassMembers(types, 'void').join('\n')}\n};\n`],
        [methodStruct, () => writeMethodStruct(types)],
    ]);
    for (const global of game.globals) {
        const type = game.types[global.definition];
        // leaves out a generic type's instance, an array and a pointer, whose C# names have these characters
        const isPlain = type !== undefined && !/[<[*]/.test(global.name);
        if (global.kind !== globalKinds.typeInfo || !isPlain || pointerTypes.has(global.definition)) {
            continue;
        }

        const base = nameBase(types, global.definition, counts);
        const writeStaticFields = () => {
            const fields = type.fields.filter(isStaticField).sort((first, second) => first.offset! - second.offset!);
            const staticMembers = fields.length > 0 ? writeMembers(types, fields, 0) : ['    uint8_t _empty;'];

            return `struct ${base}_StaticFields {\n${staticMembers.join('\n')}\n};\n`;
        };
        structs.set(`${base}_StaticFields`, writeStaticFields);
        structs.set(`${base}_c`, () => `struct ${base}_c {\n${writeClassMembers(types, `struct ${base}_StaticFields`).join('\n')}\n};\n`);
        pointerTypes.set(global.definition, `struct ${base}_c *`);
        staticStructs.set(global.definition, `${base}_StaticFields`);
    }

    return { structs, pointerTypes, staticStructs };
}
