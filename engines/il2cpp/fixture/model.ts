// the flags of ECMA-335 II.23.1, which IL2CPP keeps in the metadata unchanged
export const typeAttributes = { public: 0x1, nestedPublic: 0x2, interface: 0x20, abstract: 0x80, sealed: 0x100 };
export const methodAttributes = {
    private: 0x1,
    assembly: 0x3,
    family: 0x4,
    public: 0x6,
    static: 0x10,
    virtual: 0x40,
    hideBySig: 0x80,
    newSlot: 0x100,
    abstract: 0x400,
    specialName: 0x800,
    rtSpecialName: 0x1000,
};
export const fieldAttributes = { private: 0x1, family: 0x4, public: 0x6, static: 0x10, literal: 0x40, hasDefault: 0x8000 };

/** A field of a fixture's type, with the full name of its type, like `System.Int32`. */
export interface FixtureField {
    name: string;
    type: string;
    flags: number;
    /** The value of a constant, like an enum's member or a string. */
    value?: number | string;
}

/** A method of a fixture's type. A method without a body is abstract and doesn't have code in the binary. */
export interface FixtureMethod {
    name: string;
    returnType: string;
    parameters: { name: string; type: string }[];
    flags: number;
    /** The full name of a method that the method's code calls, like `Shapes.Circle.Area`. */
    calls?: string;
    hasBody: boolean;
    /** The function of the image's `code` that has the method's code, which 2 methods with the same function share. */
    code?: string;
}

export interface FixtureProperty {
    name: string;
    getter: string | null;
    setter: string | null;
}

/** A type of the fixture, where `primitive` is the `Il2CppTypeEnum` of a type that the runtime treats as built in. */
export interface FixtureType {
    namespace: string;
    name: string;
    kind: 'class' | 'struct' | 'interface' | 'enum';
    flags: number;
    base: string | null;
    interfaces: string[];
    /** The full name of the type that contains a nested type. */
    declaringType: string | null;
    fields: FixtureField[];
    methods: FixtureMethod[];
    properties: FixtureProperty[];
    primitive?: number;
}

export interface FixtureImage {
    name: string;
    types: FixtureType[];
    /**
     * The C source of the functions that the image's methods name in `code`, compiled the way IL2CPP compiles C#, with
     * `USAGE(kind, index)` for a metadata global's value and a `TYPE_` macro with each type's index, like
     * `TYPE_Shapes_Circle`.
     */
    code?: string;
}

const instance = methodAttributes.public | methodAttributes.hideBySig;
const constructor = instance | methodAttributes.specialName | methodAttributes.rtSpecialName;
const accessor = instance | methodAttributes.specialName;
const overriding = instance | methodAttributes.virtual;
const abstractMethod = overriding | methodAttributes.newSlot | methodAttributes.abstract;

function type(fullName: string, kind: FixtureType['kind'], parts: Partial<FixtureType> = {}): FixtureType {
    const dot = fullName.lastIndexOf('.');
    const base = { class: 'System.Object', struct: 'System.ValueType', interface: null, enum: 'System.Enum' }[kind];

    return {
        namespace: dot < 0 ? '' : fullName.slice(0, dot),
        name: fullName.slice(dot + 1),
        kind,
        flags: typeAttributes.public | (kind === 'struct' || kind === 'enum' ? typeAttributes.sealed : 0),
        base,
        interfaces: [],
        declaringType: null,
        fields: [],
        methods: [],
        properties: [],
        ...parts,
    };
}

function method(name: string, returnType: string, flags = instance, parts: Partial<FixtureMethod> = {}): FixtureMethod {
    return { name, returnType, parameters: [], flags, hasBody: (flags & methodAttributes.abstract) === 0, ...parts };
}

// gives each built-in type its `Il2CppTypeEnum` from il2cpp-runtime-metadata.h
function primitive(name: string, kind: 'class' | 'struct', value: number): FixtureType {
    return type(`System.${name}`, kind, { primitive: value });
}

/** The images of the fixture, whose first image is `mscorlib.dll` because the runtime finds its tables from there. */
export const images: FixtureImage[] = [
    {
        name: 'mscorlib.dll',
        types: [
            type('System.Object', 'class', { base: null, primitive: 0x1c, methods: [method('.ctor', 'System.Void', constructor)] }),
            type('System.ValueType', 'class', { flags: typeAttributes.public | typeAttributes.abstract }),
            type('System.Enum', 'class', { base: 'System.ValueType', flags: typeAttributes.public | typeAttributes.abstract }),
            primitive('Void', 'struct', 0x01),
            primitive('Boolean', 'struct', 0x02),
            primitive('Char', 'struct', 0x03),
            primitive('SByte', 'struct', 0x04),
            primitive('Byte', 'struct', 0x05),
            primitive('Int16', 'struct', 0x06),
            primitive('UInt16', 'struct', 0x07),
            primitive('Int32', 'struct', 0x08),
            primitive('UInt32', 'struct', 0x09),
            primitive('Int64', 'struct', 0x0a),
            primitive('UInt64', 'struct', 0x0b),
            primitive('Single', 'struct', 0x0c),
            primitive('Double', 'struct', 0x0d),
            primitive('String', 'class', 0x0e),
            primitive('TypedReference', 'struct', 0x16),
            primitive('IntPtr', 'struct', 0x18),
            primitive('UIntPtr', 'struct', 0x19),
        ],
    },
    {
        name: 'Assembly-CSharp.dll',
        types: [
            type('Shapes.IDrawable', 'interface', {
                flags: typeAttributes.public | typeAttributes.interface | typeAttributes.abstract,
                methods: [method('Draw', 'System.Void', abstractMethod)],
            }),
            type('Shapes.Shape', 'class', {
                flags: typeAttributes.public | typeAttributes.abstract,
                fields: [{ name: 'name', type: 'System.String', flags: fieldAttributes.family }],
                methods: [
                    method('.ctor', 'System.Void', constructor, { parameters: [{ name: 'name', type: 'System.String' }] }),
                    method('Area', 'System.Single', abstractMethod),
                    method('Describe', 'System.String', overriding | methodAttributes.newSlot),
                ],
            }),
            type('Shapes.Circle', 'class', {
                base: 'Shapes.Shape',
                interfaces: ['Shapes.IDrawable'],
                fields: [
                    { name: 'radius', type: 'System.Single', flags: fieldAttributes.private },
                    { name: 'count', type: 'System.Int32', flags: fieldAttributes.public | fieldAttributes.static },
                ],
                methods: [
                    method('.ctor', 'System.Void', constructor, { parameters: [{ name: 'radius', type: 'System.Single' }] }),
                    method('Area', 'System.Single', overriding),
                    method('Draw', 'System.Void', overriding | methodAttributes.newSlot),
                    method('get_Radius', 'System.Single', accessor),
                    method('set_Radius', 'System.Void', accessor, { parameters: [{ name: 'value', type: 'System.Single' }] }),
                    method('Unit', 'Shapes.Circle', instance | methodAttributes.static),
                    method('Scale', 'System.Single[]', instance, { parameters: [{ name: 'factors', type: 'System.Single[]' }] }),
                ],
                properties: [{ name: 'Radius', getter: 'get_Radius', setter: 'set_Radius' }],
            }),
            type('Shapes.Circle.Builder', 'class', {
                flags: typeAttributes.nestedPublic,
                declaringType: 'Shapes.Circle',
                methods: [method('Build', 'Shapes.Circle', instance, { calls: 'Shapes.Circle.Unit' })],
            }),
            type('Shapes.Point', 'struct', {
                fields: [
                    { name: 'x', type: 'System.Int32', flags: fieldAttributes.public },
                    { name: 'y', type: 'System.Int32', flags: fieldAttributes.public },
                ],
                methods: [method('Length', 'System.Single')],
            }),
            type('Shapes.Color', 'enum', {
                fields: [
                    { name: 'value__', type: 'System.Int32', flags: fieldAttributes.public },
                    ...['Red', 'Green', 'Blue'].map((name, value) => ({
                        name,
                        type: 'Shapes.Color',
                        flags: fieldAttributes.public | fieldAttributes.static | fieldAttributes.literal | fieldAttributes.hasDefault,
                        value,
                    })),
                ],
            }),
            type('Player', 'class', {
                methods: [method('Start', 'System.Void'), method('Update', 'System.Void', instance, { calls: 'Shapes.Circle.Area' })],
            }),
        ],
    },
];

/** The string literals that the fixture's code uses. */
export const stringLiterals = ['shapes fixture', 'héllo ✓'];

/** Returns a type's full name, like `Shapes.Circle.Builder` for a nested type. */
export function fullName({ namespace, name }: FixtureType): string {
    return namespace === '' ? name : `${namespace}.${name}`;
}
