import { type FixtureImage, type FixtureMethod, type FixtureType, fullName, images } from './model';

// the `Il2CppTypeEnum` values of il2cpp-runtime-metadata.h that the fixture uses besides the built-in types
export const typeEnum = { valueType: 0x11, class: 0x12, genericParameter: 0x13, genericInstance: 0x15, szArray: 0x1d };
// the token tables of ECMA-335 II.22, in a token's top byte
const tables = { typeDefinition: 0x02, field: 0x04, method: 0x06, parameter: 0x08, property: 0x17 };

/** An entry of the binary's `Il2CppType` table with a type definition's index or an array's element type's index. */
export interface BinaryType {
    type: number;
    attributes: number;
    isValueType: boolean;
    /** Whether a parameter takes the type by reference, like `ref bool`. */
    isByReference: boolean;
    data: { definition: number } | { element: number } | { parameter: number } | { genericClass: number };
}

/** A generic type's instance, by its definition's index and the index of its arguments' list in `genericInsts`. */
export interface GenericClass {
    definition: number;
    inst: number;
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

    // gives each generic type's parameters their indexes in the metadata's table of generic parameters
    const parameterStarts = new Map<number, number>();
    let parameterCount = 0;
    for (const { type, index } of types) {
        if (type.genericParameters) {
            parameterStarts.set(index, parameterCount);
            parameterCount += type.genericParameters.length;
        }
    }

    const genericInsts: number[][] = [];
    const genericClasses: GenericClass[] = [];

    function addOnce<Item>(list: Item[], item: Item): number {
        const found = list.findIndex(entry => JSON.stringify(entry) === JSON.stringify(item));

        return found >= 0 ? found : list.push(item) - 1;
    }

    // splits the arguments of a generic type's instance, like `A, B<C, D>`, at the commas outside of brackets
    function splitArguments(text: string): string[] {
        const parts: string[] = [];
        let depth = 0;
        let start = 0;
        [...text].forEach((character, index) => {
            depth += character === '<' ? 1 : character === '>' ? -1 : 0;
            if (character === ',' && depth === 0) {
                parts.push(text.slice(start, index).trim());
                start = index + 1;
            }
        });

        return [...parts, text.slice(start).trim()];
    }

    // returns a type's entry without its attributes, for an array like `System.Single[]`, a generic type's parameter
    // like `Shapes.Singleton`1!0`, a generic type's instance like `Shapes.Singleton`1<Shapes.Circle>` or a definition
    function describe(name: string): Omit<BinaryType, 'attributes' | 'isByReference'> {
        const parameter = /^(.+)!(\d+)$/.exec(name);
        const generic = /^([^<]+)<(.+)>$/.exec(name);
        if (name.endsWith('[]')) {
            return { type: typeEnum.szArray, isValueType: false, data: { element: typeIndex(name.slice(0, -2)) } };
        }
        if (parameter) {
            const start = parameterStarts.get(findType(parameter[1]).index)!;

            return { type: typeEnum.genericParameter, isValueType: false, data: { parameter: start + Number(parameter[2]) } };
        }
        if (generic) {
            const inst = addOnce(genericInsts, splitArguments(generic[2]).map(argument => typeIndex(argument)));
            const genericClass = addOnce(genericClasses, { definition: findType(generic[1]).index, inst });

            return { type: typeEnum.genericInstance, isValueType: false, data: { genericClass } };
        }

        const { type, isValueType } = binaryTypes[findType(name).index];

        return { type, isValueType, data: { definition: findType(name).index } };
    }

    /**
     * Returns the binary type index of a type name like `System.Single[]` or `ref System.Boolean` with attributes,
     * adding the entry once.
     */
    function typeIndex(fullName: string, attributes = 0): number {
        const isByReference = fullName.startsWith('ref ');
        const { type, isValueType, data } = describe(isByReference ? fullName.slice(4) : fullName);
        const found = binaryTypes.findIndex(entry => {
            const isSame = entry.attributes === attributes && entry.isByReference === isByReference;

            return isSame && JSON.stringify(entry.data) === JSON.stringify(data);
        });

        return found >= 0 ? found : binaryTypes.push({ type, attributes, isValueType, isByReference, data }) - 1;
    }

    // adds every entry that the metadata and the binary's tables use before the writers run, so the binary's table is
    // whole for both
    for (const { type } of types) {
        type.rgctx?.forEach(entry => typeIndex(entry.type));
        for (const field of type.fields) {
            typeIndex(field.type, field.flags & 0xffff);
        }
        for (const method of type.methods) {
            typeIndex(method.returnType);
            method.parameters.forEach(parameter => typeIndex(parameter.type));
        }
    }

    const methodSpecs = fixtureImages.flatMap(image => image.methodSpecs ?? []).map(({ method, classArguments }) => {
        const dot = method.lastIndexOf('.');
        const found = methods.find(laidOut => fullName(laidOut.owner.type) === method.slice(0, dot) && laidOut.method.name === method.slice(dot + 1));

        return { method: found!.index, classInst: addOnce(genericInsts, classArguments.map(argument => typeIndex(argument))) };
    });

    return {
        images: fixtureImages,
        types,
        methods,
        findType,
        typeIndex,
        binaryTypes,
        parameterStarts,
        genericInsts,
        genericClasses,
        methodSpecs,
        nextToken,
        tables,
    };
}

export type Layout = ReturnType<typeof layOut>;
