import type { Layout } from './layout';
import { fullName } from './model';

/** The magic number that starts a `global-metadata.dat` file, as a little-endian 32-bit number. */
export const metadataMagic = 0xfab11baf;
/**
 * Provides the metadata layouts that the fixture writes, Unity 2022.3's 31.1 and Unity 2021.2's 29.0, with the fields
 * that each layout has. Version 29.0 doesn't have a method's `returnParameterToken` or the code registration's
 * `unresolvedInstanceCallPointers` and `unresolvedStaticCallPointers`, so a binary in the 29.0 layout doesn't read as
 * 29.1.
 */
export const fixtureLayouts = {
    '31.1': { version: 31, hasReturnParameterToken: true, hasUnresolvedCallPointers: true },
    '29.0': { version: 29, hasReturnParameterToken: false, hasUnresolvedCallPointers: false },
};

/** A metadata layout that the fixture writes. */
export type FixtureLayout = (typeof fixtureLayouts)[keyof typeof fixtureLayouts];

// the sections of the version 31 header in their order, from il2cpp-metadata.h
const sectionNames = [
    'stringLiteral',
    'stringLiteralData',
    'string',
    'events',
    'properties',
    'methods',
    'parameterDefaultValues',
    'fieldDefaultValues',
    'fieldAndParameterDefaultValueData',
    'fieldMarshaledSizes',
    'parameters',
    'fields',
    'genericParameters',
    'genericParameterConstraints',
    'genericContainers',
    'nestedTypes',
    'interfaces',
    'vtableMethods',
    'interfaceOffsets',
    'typeDefinitions',
    'images',
    'assemblies',
    'fieldRefs',
    'referencedAssemblies',
    'attributeData',
    'attributeDataRange',
    'unresolvedVirtualCallParameterTypes',
    'unresolvedVirtualCallParameterRanges',
    'windowsRuntimeTypeNames',
    'windowsRuntimeStrings',
    'exportedTypeDefinitions',
] as const;

type SectionName = (typeof sectionNames)[number];

// the zero bytes after the last section, which an empty section points at because the reader reads 1 record there
const paddingBytes = 128;

/** Collects little-endian 32-bit and 16-bit numbers into bytes. */
class Records {
    private readonly values: { value: number; bytes: 2 | 4 }[] = [];

    int32(...values: number[]): this {
        values.forEach(value => this.values.push({ value, bytes: 4 }));
        return this;
    }

    uint16(...values: number[]): this {
        values.forEach(value => this.values.push({ value, bytes: 2 }));
        return this;
    }

    toBytes(): Uint8Array {
        const bytes = new Uint8Array(this.values.reduce((sum, { bytes: size }) => sum + size, 0));
        const view = new DataView(bytes.buffer);
        let offset = 0;
        for (const { value, bytes: size } of this.values) {
            if (size === 4) {
                view.setInt32(offset, value | 0, true);
            } else {
                view.setUint16(offset, value, true);
            }
            offset += size;
        }

        return bytes;
    }
}

/** Keeps each name once in the string section, where a name's index is its byte offset. */
class StringTable {
    private readonly offsets = new Map<string, number>();
    private readonly parts: Uint8Array[] = [];
    private size = 0;

    constructor() {
        this.index('');
    }

    index(text: string): number {
        let offset = this.offsets.get(text);
        if (offset === undefined) {
            offset = this.size;
            const bytes = new TextEncoder().encode(`${text}\0`);
            this.parts.push(bytes);
            this.offsets.set(text, offset);
            this.size += bytes.length;
        }

        return offset;
    }

    toBytes(): Uint8Array {
        return Buffer.concat(this.parts);
    }
}

// writes the field, method, parameter and property records of every type and returns them by section
function writeMembers(layout: Layout, strings: StringTable, metadataLayout: FixtureLayout) {
    const fields = new Records();
    const fieldDefaultValues = new Records();
    const defaultValueData: number[] = [];
    const methods = new Records();
    const parameters = new Records();
    const properties = new Records();
    let fieldCount = 0;
    let parameterCount = 0;

    for (const { type, imageIndex } of layout.types) {
        for (const field of type.fields) {
            if (typeof field.value === 'number') {
                fieldDefaultValues.int32(fieldCount, layout.typeIndex('System.Int32'), defaultValueData.length);
                // writes Unity's compressed signed number, which keeps the sign in the lowest bit, for a value below 64
                defaultValueData.push(field.value << 1);
            } else if (field.value !== undefined) {
                const bytes = new TextEncoder().encode(field.value);
                fieldDefaultValues.int32(fieldCount, layout.typeIndex('System.String'), defaultValueData.length);
                // writes the string's length as a compressed signed number before the UTF-8 bytes, like Unity
                defaultValueData.push(bytes.length << 1, ...bytes);
            }
            fields.int32(
                strings.index(field.name),
                layout.typeIndex(field.type, field.flags & 0xffff),
                layout.nextToken(imageIndex, layout.tables.field),
            );
            fieldCount++;
        }
    }

    for (const { method, owner, token } of layout.methods) {
        const firstParameter = parameterCount;
        for (const parameter of method.parameters) {
            parameters.int32(
                strings.index(parameter.name),
                layout.nextToken(owner.imageIndex, layout.tables.parameter),
                layout.typeIndex(parameter.type),
            );
            parameterCount++;
        }

        const returnType = layout.typeIndex(method.returnType);
        methods.int32(strings.index(method.name), owner.index, returnType);
        if (metadataLayout.hasReturnParameterToken) {
            methods.int32(0);
        }

        methods.int32(firstParameter, -1, token);
        methods.uint16(method.flags, 0, 0xffff, method.parameters.length);
    }

    for (const { type, imageIndex } of layout.types) {
        for (const property of type.properties) {
            const getter = property.getter === null ? -1 : type.methods.findIndex(found => found.name === property.getter);
            const setter = property.setter === null ? -1 : type.methods.findIndex(found => found.name === property.setter);
            properties.int32(strings.index(property.name), getter, setter, 0, layout.nextToken(imageIndex, layout.tables.property));
        }
    }

    return {
        fields: fields.toBytes(),
        fieldDefaultValues: fieldDefaultValues.toBytes(),
        fieldAndParameterDefaultValueData: new Uint8Array(defaultValueData),
        methods: methods.toBytes(),
        parameters: parameters.toBytes(),
        properties: properties.toBytes(),
    };
}

// writes the generic container of each generic type with its parameters, and returns the containers' indexes by the
// types' indexes
function writeGenericContainers(layout: Layout, strings: StringTable) {
    const genericContainers = new Records();
    const genericParameters = new Records();
    const containerIndexes = new Map<number, number>();

    for (const [typeIndex, start] of layout.parameterStarts) {
        const names = layout.types[typeIndex].type.genericParameters!;
        containerIndexes.set(typeIndex, containerIndexes.size);
        genericContainers.int32(typeIndex, names.length, 0, start);
        names.forEach((name, number) => {
            genericParameters.int32(containerIndexes.get(typeIndex)!, strings.index(name)).uint16(0, 0, number, 0);
        });
    }

    return { genericContainers: genericContainers.toBytes(), genericParameters: genericParameters.toBytes(), containerIndexes };
}

// writes the type definition records with the nested type and interface lists that they point into
function writeTypes(layout: Layout, strings: StringTable, containerIndexes: Map<number, number>) {
    const typeDefinitions = new Records();
    const nestedTypes = new Records();
    const interfaces = new Records();
    const counts = { field: 0, method: 0, property: 0, nested: 0, interface: 0 };

    for (const { type, index, token } of layout.types) {
        const nested = layout.types.filter(found => found.type.declaringType === fullName(type));
        nested.forEach(found => nestedTypes.int32(found.index));
        type.interfaces.forEach(name => interfaces.int32(layout.typeIndex(name)));

        const declaring = type.declaringType === null ? -1 : layout.findType(type.declaringType).index;
        const parent = type.base === null ? -1 : layout.typeIndex(type.base);
        const element = type.kind === 'enum' ? layout.typeIndex('System.Int32') : index;
        // writes an empty namespace for a nested type, like Unity's metadata does
        const namespace = type.declaringType === null ? type.namespace : '';
        const isValueType = type.kind === 'struct' || type.kind === 'enum';
        const bitfield = (isValueType ? 1 : 0) | (type.kind === 'enum' ? 2 : 0);

        const container = containerIndexes.get(index) ?? -1;
        typeDefinitions.int32(strings.index(type.name), strings.index(namespace), index, declaring, parent, element, container, type.flags);
        typeDefinitions.int32(counts.field, counts.method, 0, counts.property, counts.nested, counts.interface, 0, 0);
        typeDefinitions.uint16(type.methods.length, type.properties.length, type.fields.length, 0);
        typeDefinitions.uint16(nested.length, 0, type.interfaces.length, 0);
        typeDefinitions.int32(bitfield, token);

        counts.field += type.fields.length;
        counts.method += type.methods.length;
        counts.property += type.properties.length;
        counts.nested += nested.length;
        counts.interface += type.interfaces.length;
    }

    return { typeDefinitions: typeDefinitions.toBytes(), nestedTypes: nestedTypes.toBytes(), interfaces: interfaces.toBytes() };
}

// writes 1 image and 1 assembly for each of the fixture's images
function writeImages(layout: Layout, strings: StringTable) {
    const images = new Records();
    const assemblies = new Records();
    let firstType = 0;

    layout.images.forEach((image, index) => {
        images.int32(strings.index(image.name), index, firstType, image.types.length, 0, 0, -1, 1, 0, 0);
        assemblies.int32(index, 0x20000001, 0, 0);
        assemblies.int32(strings.index(image.name.replace(/\.dll$/, '')), strings.index(''), strings.index(''), 0, 0, 0, 0, 0, 0, 0, 0, 0);
        firstType += image.types.length;
    });

    return { images: images.toBytes(), assemblies: assemblies.toBytes() };
}

function writeStringLiterals(literals: string[]) {
    const records = new Records();
    const data: Uint8Array[] = [];
    let size = 0;
    for (const literal of literals) {
        const bytes = new TextEncoder().encode(literal);
        records.int32(bytes.length, size);
        data.push(bytes);
        size += bytes.length;
    }

    return { stringLiteral: records.toBytes(), stringLiteralData: Buffer.concat(data) };
}

/** Writes the fixture's `global-metadata.dat` in a layout, 31.1 when the caller doesn't give one. */
export function writeMetadata(layout: Layout, literals: string[], metadataLayout: FixtureLayout = fixtureLayouts['31.1']): Uint8Array {
    const strings = new StringTable();
    const { containerIndexes, ...generics } = writeGenericContainers(layout, strings);
    const sections: Partial<Record<SectionName, Uint8Array>> = {
        ...writeStringLiterals(literals),
        ...writeMembers(layout, strings, metadataLayout),
        ...generics,
        ...writeTypes(layout, strings, containerIndexes),
        ...writeImages(layout, strings),
    };
    sections.string = strings.toBytes();

    const headerBytes = 8 + sectionNames.length * 8;
    const header = new Records().int32(metadataMagic, metadataLayout.version);
    const parts: Uint8Array[] = [];
    let offset = headerBytes;
    const sectionOffsets = sectionNames.map(name => {
        const bytes = sections[name] ?? new Uint8Array(0);
        const start = offset;
        // keeps each section on a 4-byte boundary like Unity's writer
        const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
        padded.set(bytes);
        parts.push(padded);
        offset += padded.length;

        return { start, size: bytes.length };
    });

    for (const { start, size } of sectionOffsets) {
        header.int32(size === 0 ? offset : start, size);
    }

    return Buffer.concat([header.toBytes(), ...parts, new Uint8Array(paddingBytes)]);
}
