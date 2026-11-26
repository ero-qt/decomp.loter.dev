import { type BinaryType, functionName, type LaidOutType, type Layout } from './layout';
import { type FixtureLayout, fixtureLayouts } from './metadata';
import { fieldAttributes, type FixtureField, fullName } from './model';

// the slots after the code gen modules, which keep the runtime's backward search from matching data after the list
const moduleListPadding = 8;
// IL2CPP's encoding of a usage since version 27, with the TypeInfo kind 1 in the top 3 bits, type index 0 and the low
// bit set
const typeInfoUsage = (1 << 29) | (0 << 1) | 1;

const prelude = `typedef __SIZE_TYPE__ usize;

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

typedef struct Il2CppType {
	const void *data;
	unsigned int bits;
} Il2CppType;

struct GenericInst {
	usize type_argc;
	const Il2CppType *const *type_argv;
};

struct GenericClass {
	const Il2CppType *type;
	const struct GenericInst *class_inst;
	const struct GenericInst *method_inst;
	void *cached_class;
};

struct TokenRange {
	unsigned int token;
	int start;
	int length;
};

struct RgctxDefinition {
	int type;
	const int *data;
};

struct Il2CppCodeGenModule {
	const char *moduleName;
	usize methodPointerCount;
	void *const *methodPointers;
	usize adjustorThunkCount;
	const void *adjustorThunks;
	const void *invokerIndices;
	usize reversePInvokeWrapperCount;
	const void *reversePInvokeWrapperIndices;
	usize rgctxRangesCount;
	const void *rgctxRanges;
	usize rgctxsCount;
	const void *rgctxs;
	const void *debuggerMetadata;
	const void *moduleInitializer;
	const void *staticConstructorTypeIndices;
	const void *metadataRegistration;
	const void *codeRegistration;
};

struct Il2CppCodeRegistration {
	usize reversePInvokeWrapperCount;
	const void *reversePInvokeWrappers;
	usize genericMethodPointersCount;
	const void *genericMethodPointers;
	const void *genericAdjustorThunks;
	usize invokerPointersCount;
	const void *invokerPointers;
	usize unresolvedVirtualCallCount;
	const void *unresolvedVirtualCallPointers;
	const void *unresolvedInstanceCallPointers;
	const void *unresolvedStaticCallPointers;
	usize interopDataCount;
	const void *interopData;
	usize windowsRuntimeFactoryCount;
	const void *windowsRuntimeFactoryTable;
	usize codeGenModulesCount;
	const struct Il2CppCodeGenModule *const *codeGenModules;
};

struct Il2CppMetadataRegistration {
	usize genericClassesCount;
	const void *genericClasses;
	usize genericInstsCount;
	const void *genericInsts;
	usize genericMethodTableCount;
	const void *genericMethodTable;
	usize typesCount;
	const Il2CppType *const *types;
	usize methodSpecsCount;
	const void *methodSpecs;
	usize fieldOffsetsCount;
	const int *const *fieldOffsets;
	usize typeDefinitionsSizesCount;
	const unsigned int *const *typeDefinitionsSizes;
	usize metadataUsagesCount;
	const void *metadataUsages;
};

extern const struct Il2CppCodeRegistration g_CodeRegistration;
extern const struct Il2CppMetadataRegistration g_MetadataRegistration;

static const usize emptyTable[1];

EXPORT void il2cpp_init(const char *domain)
{
	(void)domain;
}
`;

function fieldBytes(field: FixtureField, pointerSize: number): number {
    return field.type === 'System.Int32' || field.type === 'System.Single' ? 4 : pointerSize;
}

function isInstanceField(field: FixtureField): boolean {
    return (field.flags & (fieldAttributes.static | fieldAttributes.literal)) === 0;
}

// returns the instance fields' offsets after the object's header of 2 pointers and the base types' fields, which
// Unity's field offsets include, the statics' offsets and the type's sizes
function placeFields(layout: Layout, owner: LaidOutType, pointerSize: number) {
    const chain: FixtureField[] = [];
    for (let base = owner.type.base; base !== null; base = layout.findType(base).type.base) {
        chain.unshift(...layout.findType(base).type.fields.filter(isInstanceField));
    }

    const align = (end: number, size: number) => Math.ceil(end / size) * size;
    let instanceEnd = chain.reduce((end, field) => align(end, fieldBytes(field, pointerSize)) + fieldBytes(field, pointerSize), 2 * pointerSize);
    let staticEnd = 0;
    const offsets = owner.type.fields.map(field => {
        const size = fieldBytes(field, pointerSize);
        if ((field.flags & fieldAttributes.literal) !== 0) {
            return 0;
        }
        if (!isInstanceField(field)) {
            const offset = staticEnd;
            staticEnd += size;

            return offset;
        }

        const offset = align(instanceEnd, size);
        instanceEnd = offset + size;

        return offset;
    });

    return { offsets, instanceSize: instanceEnd, staticSize: staticEnd };
}

// writes the macros with the metadata's indexes for the images' code, and the code of each image that has code
function writeImageCode(layout: Layout): string[] {
    const codes = layout.images.flatMap(image => (image.code === undefined ? [] : [image.code]));
    if (codes.length === 0) {
        return [];
    }

    const typeMacros = layout.types.map(({ type, index }) => `#define TYPE_${fullName(type).replace(/[^A-Za-z0-9_]/g, '_')} ${index}`);

    // the first method of each C name, because overloads share it
    const methodIndexes = new Map<string, number>();
    for (const { method, owner, index } of layout.methods) {
        const name = functionName(owner.type, method);
        if (!methodIndexes.has(name)) {
            methodIndexes.set(name, index);
        }
    }
    const methodMacros = [...methodIndexes].map(([name, index]) => `#define METHOD_${name} ${index}`);

    return ['', '#define USAGE(kind, index) (((usize)(kind) << 29) | ((usize)(index) << 1) | 1)', ...typeMacros, ...methodMacros, '', ...codes];
}

function writeFunctions(layout: Layout): string[] {
    const lines: string[] = [];
    const withBody = layout.methods.filter(({ method }) => method.hasBody && method.code === undefined);
    for (const { method, owner } of withBody) {
        lines.push(`long ${functionName(owner.type, method)}(long value);`);
    }

    // gives each function a different constant, so the linker doesn't fold 2 functions into 1
    withBody.forEach(({ method, owner, index }) => {
        const callee = layout.methods.find(found => `${fullName(found.owner.type)}.${found.method.name}` === method.calls);
        const result = callee === undefined ? `value * 3 + ${index + 1}` : `${functionName(callee.owner.type, callee.method)}(value) + ${index + 1}`;
        lines.push('', `__attribute__((noinline)) long ${functionName(owner.type, method)}(long value)`, '{', `\treturn ${result};`, '}');
    });

    return [...lines, ...writeImageCode(layout)];
}

function writeTypeData(data: BinaryType['data']): string {
    if ('element' in data) {
        return `&type${data.element}`;
    }

    return 'genericClass' in data ? `&genericClass${data.genericClass}` : `(const void *)${'definition' in data ? data.definition : data.parameter}`;
}

// writes the lists of generic arguments and the generic classes, which point to the types that the type table defines
// after them
function writeGenerics(layout: Layout): string[] {
    const declarations = layout.binaryTypes.map((_, index) => `static const Il2CppType type${index};`);
    const insts = layout.genericInsts.flatMap((types, index) => [
        `static const Il2CppType *const instTypes${index}[] = { ${types.map(type => `&type${type}`).join(', ')} };`,
        `static const struct GenericInst inst${index} = { ${types.length}, instTypes${index} };`,
    ]);
    const classes = layout.genericClasses.map(({ definition, inst }, index) => {
        return `static const struct GenericClass genericClass${index} = { &type${definition}, &inst${inst}, 0, 0 };`;
    });

    return [...declarations, ...insts, ...classes];
}

function writeTypeTable(layout: Layout): string[] {
    const lines = layout.binaryTypes.map(({ type, attributes, isValueType, isByReference, data }, index) => {
        // packs attrs, type, num_mods, byref, pinned and valuetype like the 5-bit num_mods layout since metadata 27.2
        const bits = (attributes | (type << 16) | ((isByReference ? 1 : 0) << 29) | ((isValueType ? 1 : 0) << 31)) >>> 0;

        return `static const Il2CppType type${index} = { ${writeTypeData(data)}, 0x${bits.toString(16)}u };`;
    });
    const entries = layout.binaryTypes.map((_, index) => `&type${index}`).join(', ');

    return [...lines, `static const Il2CppType *const types[] = { ${entries} };`];
}

// writes a list as a C array, or uses the empty table for an empty list, because C doesn't have empty arrays
function writeList(name: string, type: string, items: string[]): { lines: string[]; pointer: string } {
    if (items.length === 0) {
        return { lines: [], pointer: 'emptyTable' };
    }

    return { lines: [`static ${type} ${name}[] = { ${items.join(', ')} };`], pointer: name };
}

// writes the token ranges and the definitions of the runtime generic contexts of an image's types
function writeRgctxs(layout: Layout, imageIndex: number): { lines: string[]; fields: string } {
    const owners = layout.types.filter(({ type, imageIndex: index }) => index === imageIndex && type.rgctx !== undefined);
    const entries = owners.flatMap(({ type }) => type.rgctx!);
    const data = entries.map((entry, index) => `static const int rgctxData${imageIndex}_${index} = ${layout.typeIndex(entry.type)};`);
    let start = 0;
    const ranges = writeList(`rgctxRanges${imageIndex}`, 'const struct TokenRange', owners.map(({ type, token }) => {
        start += type.rgctx!.length;

        return `{ 0x${token.toString(16)}u, ${start - type.rgctx!.length}, ${type.rgctx!.length} }`;
    }));
    const definitions = writeList(`rgctxs${imageIndex}`, 'const struct RgctxDefinition', entries.map((entry, index) => {
        return `{ ${entry.kind}, &rgctxData${imageIndex}_${index} }`;
    }));
    const fields = `${owners.length}, ${ranges.pointer}, ${entries.length}, ${definitions.pointer}`;

    return { lines: [...data, ...ranges.lines, ...definitions.lines], fields };
}

function writeTypeSizes(layout: Layout, pointerSize: number): string[] {
    const lines: string[] = [];
    for (const owner of layout.types) {
        const { offsets, instanceSize, staticSize } = placeFields(layout, owner, pointerSize);
        lines.push(`static const unsigned int sizes${owner.index}[] = { ${instanceSize}, -1, ${staticSize}, 0 };`);
        if (offsets.length > 0) {
            lines.push(`static const int offsets${owner.index}[] = { ${offsets.join(', ')} };`);
        }
    }

    const sizes = layout.types.map(({ index }) => `sizes${index}`).join(', ');
    const offsets = layout.types.map(({ type, index }) => (type.fields.length > 0 ? `offsets${index}` : '0')).join(', ');

    return [...lines, `static const unsigned int *const typeSizes[] = { ${sizes} };`, `static const int *const fieldOffsets[] = { ${offsets} };`];
}

function writeModules(layout: Layout, metadataLayout: FixtureLayout): string[] {
    const lines: string[] = [];
    layout.images.forEach((image, imageIndex) => {
        const methods = layout.methods.filter(({ owner }) => owner.imageIndex === imageIndex);
        const pointers = methods.map(({ method, owner }) => (method.hasBody ? `(void *)${method.code ?? functionName(owner.type, method)}` : '0'));
        const rgctxs = writeRgctxs(layout, imageIndex);
        lines.push(`static void *const methodPointers${imageIndex}[] = { ${pointers.join(', ')} };`, ...rgctxs.lines);
        lines.push(`static const struct Il2CppCodeGenModule module${imageIndex} = {`);
        lines.push(`\t"${image.name}", ${methods.length}, methodPointers${imageIndex}, 0, 0, 0, 0, 0, ${rgctxs.fields}, 0, 0, 0,`);
        lines.push('\t&g_MetadataRegistration, &g_CodeRegistration', '};');
    });

    const modules = layout.images.map((_, index) => `&module${index}`).join(', ');
    const count = layout.images.length;
    const typeCount = layout.types.length;
    const classes = writeList('genericClasses', 'const struct GenericClass *const', layout.genericClasses.map((_, index) => `&genericClass${index}`));
    const insts = writeList('genericInsts', 'const struct GenericInst *const', layout.genericInsts.map((_, index) => `&inst${index}`));
    const specs = writeList('methodSpecs', 'const int', layout.methodSpecs.map(({ method, classInst }) => `${method}, ${classInst}, -1`));

    return [
        ...lines,
        ...classes.lines,
        ...insts.lines,
        ...specs.lines,
        `static const struct Il2CppCodeGenModule *const codeGenModules[${count + moduleListPadding}] = { ${modules} };`,
        '',
        'const struct Il2CppCodeRegistration g_CodeRegistration = {',
        `\t${Array(metadataLayout.hasUnresolvedCallPointers ? 15 : 13).fill('0').join(', ')}, ${count}, codeGenModules`,
        '};',
        '',
        'const struct Il2CppMetadataRegistration g_MetadataRegistration = {',
        `\t${layout.genericClasses.length}, ${classes.pointer}, ${layout.genericInsts.length}, ${insts.pointer}, 0, emptyTable,`,
        `\t${layout.binaryTypes.length}, types, ${layout.methodSpecs.length}, ${specs.pointer},`,
        `\t${typeCount}, fieldOffsets, ${typeCount}, typeSizes, 0, 0`,
        '};',
        '',
        '// the TypeInfo global of the first type, which IL2CPP fills from the usage that it encodes in the global',
        `usize typeInfo0 = 0x${typeInfoUsage.toString(16)}u;`,
    ];
}

/**
 * Writes the C source of the fixture's binary with a function for each method with a body, the type table, the field
 * offsets and the registration structs in a layout, 31.1 when the caller doesn't give one, for a binary with pointers
 * of 8 bytes or of another size. The runtime finds the registration structs by their contents.
 */
export function writeRegistration(layout: Layout, metadataLayout: FixtureLayout = fixtureLayouts['31.1'], pointerSize = 8): string {
    const parts = [
        writeFunctions(layout),
        writeGenerics(layout),
        writeTypeTable(layout),
        writeTypeSizes(layout, pointerSize),
        writeModules(layout, metadataLayout),
    ];

    return [prelude, ...parts.flatMap(lines => [...lines, ''])].join('\n');
}
