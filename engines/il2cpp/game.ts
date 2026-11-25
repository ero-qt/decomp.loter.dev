/**
 * A game as the C# export reads it from the metadata, in the shape of the C# model. The members' types and addresses
 * are `null` without the binary.
 */
export interface Game {
    fileVersion: number;
    /** The layout that LibCpp2IL read the metadata with, like `24.5`. */
    layout: string;
    /** Whether the version has more than 1 layout, so the engine took the first layout that read the file. */
    isLayoutGuessed: boolean;
    /** The Unity version that picked the layout among the candidates, like `2019.4.21f1`. */
    unityVersion: string;
    /** The size of a pointer in the binary, 4 or 8, or 0 without the binary. */
    pointerSize: number;
    images: GameImage[];
    types: GameType[];
    strings: string[];
    /** The binary's metadata globals, which are empty without the binary. */
    globals: GameGlobal[];
}

/** The kinds of IL2CPP's metadata usages, by the numbers of `Il2CppMetadataUsage`. */
export const globalKinds = { typeInfo: 1, type: 2, methodDef: 3, fieldInfo: 4, stringLiteral: 5, methodRef: 6 } as const;

/**
 * A global of the binary that IL2CPP fills with a piece of metadata, like a class's `Il2CppClass` pointer, with its
 * address relative to the image and its kind in `globalKinds`. The name is the type's C# name, like `List<int>`, the
 * method's or field's name, or the generic method's name, with the index of the type definition that it belongs to,
 * or -1. A string literal's global has the literal's index as its definition. A global of a method or a field has the
 * member's index among its type's methods or fields, or -1.
 */
export interface GameGlobal {
    rva: number;
    kind: number;
    name: string;
    definition: number;
    member: number;
    /** The global's C# form, like `typeof(Circle)`, `List<int>.Add` or a string literal. */
    text: string;
    /** The place of the type's name in the text, like `Circle` in `typeof(Circle)`. */
    typeStart: number;
    typeLength: number;
    /** The parts of the text that name a type definition by its index, or the global's own method or field. */
    parts: { start: number; length: number; definition: number; isMember: boolean }[];
}

/** An assembly's image, whose types are the run of `typeCount` types from `firstType`. */
export interface GameImage {
    name: string;
    firstType: number;
    typeCount: number;
}

export interface GameType {
    namespace: string;
    /** The name with the count of generic parameters after a backtick, like `List`1`. */
    name: string;
    /** The index of the type that contains a nested type, or -1 at the top. */
    declaringType: number;
    /** The type's `TypeAttributes` of ECMA-335 II.23.1.15. */
    flags: number;
    isValueType: boolean;
    isEnum: boolean;
    genericParameters: string[];
    baseType: TypeReference | null;
    fields: GameField[];
    methods: GameMethod[];
    properties: GameProperty[];
}

/** A type in a signature by its C# name, with the index of its type definition or -1. */
export interface TypeReference {
    name: string;
    definition: number;
}

export interface GameField {
    name: string;
    type: TypeReference | null;
    /** The field's `FieldAttributes` of ECMA-335 II.23.1.5, which IL2CPP keeps in the binary. */
    flags: number | null;
    offset: number | null;
    /** A constant's value as C# writes it, like `"text"` or `2`. */
    value: string | null;
}

export interface GameMethod {
    name: string;
    /** The method's `MethodAttributes` of ECMA-335 II.23.1.10. */
    flags: number;
    returnType: TypeReference | null;
    parameters: { name: string; type: TypeReference | null }[];
    genericParameters: string[];
    /** The code's address relative to the image, or `null` for a method without code. */
    rva: number | null;
}

/** A property with the indexes of its accessors among its type's methods, or -1 without one. */
export interface GameProperty {
    name: string;
    getter: number;
    setter: number;
}
