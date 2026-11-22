import { type FixtureImage, type FixtureMethod, type FixtureType, fullName, images } from './model';

// the `Il2CppTypeEnum` values of il2cpp-runtime-metadata.h that the fixture uses besides the built-in types
export const typeEnum = { valueType: 0x11, class: 0x12, szArray: 0x1d };
// the token tables of ECMA-335 II.22, in a token's top byte
const tables = { typeDefinition: 0x02, field: 0x04, method: 0x06, parameter: 0x08, property: 0x17 };

/** An entry of the binary's `Il2CppType` table with a type definition's index or an array's element type's index. */
export interface BinaryType {
    type: number;
    attributes: number;
    isValueType: boolean;
    /** Whether a parameter takes the type by reference, like `ref bool`. */
    isByReference: boolean;
    data: { definition: number } | { element: number };
}

/** A type definition with its index and its image's index. */
export interface LaidOutType {
    type: FixtureType;
    index: number;
    imageIndex: number;
    token: number;
}

/** A method definition with its index in the metadata and its token in its image. */
export interface LaidOutMethod {
    method: FixtureMethod;
    owner: LaidOutType;
    index: number;
    token: number;
}

function token(table: number, indexInImage: number): number {
    return ((table << 24) | (indexInImage + 1)) >>> 0;
}

/** Returns a C identifier for a method, like `Shapes_Circle__Area`. */
export function functionName(owner: FixtureType, method: FixtureMethod): string {
    return `${fullName(owner)}__${method.name}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Lays out the fixture's images in the order that the metadata and the binary share. */
export function layOut(fixtureImages: FixtureImage[] = images) {
    const types: LaidOutType[] = [];
    const methods: LaidOutMethod[] = [];
    const tokenCounts = new Map<string, number>();

    function nextToken(imageIndex: number, table: number): number {
        const key = `${imageIndex}:${table}`;
        const count = tokenCounts.get(key) ?? 0;
        tokenCounts.set(key, count + 1);

        return token(table, count);
    }

    fixtureImages.forEach((image, imageIndex) => {
        for (const type of image.types) {
            types.push({ type, index: types.length, imageIndex, token: nextToken(imageIndex, tables.typeDefinition) });
        }
    });
    for (const owner of types) {
        for (const method of owner.type.methods) {
            methods.push({ method, owner, index: methods.length, token: nextToken(owner.imageIndex, tables.method) });
        }
    }

    const definitions = new Map(types.map(laidOut => [fullName(laidOut.type), laidOut]));
    function findType(name: string): LaidOutType {
        const found = definitions.get(name);
        if (!found) {
            throw new Error(`the fixture doesn't have the type ${name}`);
        }

        return found;
    }

    // starts with 1 entry for each type definition at the definition's index, which the metadata's byval index needs
    const binaryTypes: BinaryType[] = types.map(({ type, index }) => {
        const isValueType = type.kind === 'struct' || type.kind === 'enum';
        const kindType = isValueType ? typeEnum.valueType : typeEnum.class;

        return { type: type.primitive ?? kindType, attributes: 0, isValueType, isByReference: false, data: { definition: index } };
    });

    /**
     * Returns the binary type index of a type name like `System.Single[]` or `ref System.Boolean` with attributes,
     * adding the entry once.
     */
    function typeIndex(fullName: string, attributes = 0): number {
        const isByReference = fullName.startsWith('ref ');
        const name = isByReference ? fullName.slice(4) : fullName;
        const element = name.endsWith('[]') ? typeIndex(name.slice(0, -2)) : undefined;
        const definition = element === undefined ? findType(name).index : undefined;
        const found = binaryTypes.findIndex(entry => {
            const data = entry.data as { definition?: number; element?: number };
            const isSame = entry.attributes === attributes && entry.isByReference === isByReference;

            return isSame && data.definition === definition && data.element === element;
        });
        if (found >= 0) {
            return found;
        }

        const base = element === undefined ? binaryTypes[definition as number] : undefined;
        binaryTypes.push({
            type: base?.type ?? typeEnum.szArray,
            attributes,
            isValueType: base?.isValueType ?? false,
            isByReference,
            data: element === undefined ? { definition: definition as number } : { element },
        });

        return binaryTypes.length - 1;
    }

    // adds every entry that the metadata uses before the writers run, so the binary's table is whole for both
    for (const { type } of types) {
        for (const field of type.fields) {
            typeIndex(field.type, field.flags & 0xffff);
        }
        for (const method of type.methods) {
            typeIndex(method.returnType);
            method.parameters.forEach(parameter => typeIndex(parameter.type));
        }
    }

    return { images: fixtureImages, types, methods, findType, typeIndex, binaryTypes, nextToken, tables };
}

export type Layout = ReturnType<typeof layOut>;
