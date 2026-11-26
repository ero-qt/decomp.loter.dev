import { controlCharacters } from '../native/names-file';
import { arrayLength, type ArrayStruct, nameMembers } from './c-types';
import type { GameField, GameMethod, GameType } from './game';
import { methodFlags, stripArity } from './rows';

/** The kinds of functions for the native engine's C# printer, by the numbers of rz-ghidra's `RzGhidraCSharpKind`. */
export const functionKinds = {
    method: 0,
    getter: 1,
    setter: 2,
    constructor: 3,
    operator: 4,
    classInit: 5,
    objectNew: 6,
    writeBarrier: 7,
    raise: 8,
    metadataInit: 9,
} as const;

// the tokens of the operators that C# compiles to static methods with the names of ECMA-335 I.10.3
const operatorTokens: Record<string, string> = {
    op_Addition: '+',
    op_Subtraction: '-',
    op_Multiply: '*',
    op_Division: '/',
    op_Modulus: '%',
    op_BitwiseAnd: '&',
    op_BitwiseOr: '|',
    op_ExclusiveOr: '^',
    op_LeftShift: '<<',
    op_RightShift: '>>',
    op_Equality: '==',
    op_Inequality: '!=',
    op_LessThan: '<',
    op_GreaterThan: '>',
    op_LessThanOrEqual: '<=',
    op_GreaterThanOrEqual: '>=',
    op_UnaryNegation: '-',
    op_UnaryPlus: '+',
    op_LogicalNot: '!',
    op_OnesComplement: '~',
};

// the flags `SpecialName` and `RTSpecialName` of ECMA-335 II.23.1.10
const specialName = 0x800;
const rtSpecialName = 0x1000;

/** A method's kind, `s` for a static method or `i` and the count of its parameters in 1 text, and its C# name. */
export interface MethodRecord {
    head: string;
    name: string;
}

/**
 * Returns a type's C# name for the native engine's C# printer, without its namespace and generic parameters, or C#'s
 * keyword for `System.String` and `System.Object`.
 */
export function nameType(type: GameType): string {
    const keyword = type.namespace === 'System' && type.declaringType < 0 ? { String: 'string', Object: 'object' }[type.name] : undefined;

    return keyword ?? stripArity(type.name);
}

/**
 * Returns the function that writes the record of a type's method for the native engine's C# printer, like `1i0`
 * and `Radius` for the getter of `Circle.Radius`. An accessor has its property's name and an operator its token.
 */
export function createRecordWriter(type: GameType): (method: GameMethod, index: number) => MethodRecord {
    const accessors = new Map<number, [kind: number, name: string]>();
    for (const { name, getter, setter } of type.properties) {
        accessors.set(getter, [functionKinds.getter, name]);
        accessors.set(setter, [functionKinds.setter, name]);
    }

    return (method, index) => {
        const isStatic = (method.flags & methodFlags.static) !== 0;
        const operator = isStatic && (method.flags & specialName) !== 0 ? operatorTokens[method.name] : undefined;
        const isConstructor = !isStatic && (method.flags & rtSpecialName) !== 0 && method.name === '.ctor';
        const methodKind = isConstructor ? functionKinds.constructor : functionKinds.method;
        const [kind, name] = accessors.get(index) ?? (operator !== undefined ? [functionKinds.operator, operator] : [methodKind, method.name]);

        return { head: `${kind}${isStatic ? 's' : 'i'}${method.parameters.length}`, name };
    };
}

/** Writes a method's record in the text of a function's line of the native engine's names. */
export function formatRecord({ head, name }: MethodRecord, typeName: string): string {
    return `${head}\t${typeName}\t${name}`;
}

/**
 * Writes what a method that shares its code with other methods is in C#, for the C# printer to pick the method that a
 * call of the code fits: the method's index among the methods that share the code, its record and the structs that
 * its C parameters point to, like `Circle_o`, with a comma between them.
 */
export function writeSharerRecord(index: number, record: MethodRecord, typeName: string, structs: string[]): string {
    return `${index}\t${formatRecord(record, typeName)}\t${structs.join(',')}`;
}

/**
 * Writes what the code that several methods share is in C#. Instance methods share a method without a class, and
 * constructors a constructor without one, whose class the allocation gives. Any other methods share a function that
 * takes an object like any other argument. Returns `undefined` for methods that differ in the count of their
 * arguments.
 */
export function writeSharedRecord(methods: GameMethod[], records: MethodRecord[], name: string): string | undefined {
    const isInstance = methods.every(method => (method.flags & methodFlags.static) === 0);
    const counts = methods.map(method => method.parameters.length + (isInstance || (method.flags & methodFlags.static) !== 0 ? 0 : 1));
    if (counts.some(count => count !== counts[0])) {
        return undefined;
    }

    const isConstructor = records.every(({ head }) => head.startsWith(`${functionKinds.constructor}i`));
    const kind = isConstructor ? functionKinds.constructor : functionKinds.method;

    return formatRecord({ head: `${kind}${isInstance ? 'i' : 's'}${counts[0]}`, name }, '');
}

/**
 * Writes the lines of a class's struct for the native engine's C# printer, the class's C# name with `o`
 * for the struct of the class's objects or `s` for the struct of its static fields, and the C# name of each member
 * whose C name differs, like `<Radius>k__BackingField` for `_Radius_k__BackingField`. The class's name is the type's
 * name, or a generic type's instance's name like `Singleton<Circle>`.
 */
export function writeStructLines(structName: string, type: GameType, kind: 'o' | 's', fields: GameField[], csharpName = nameType(type)): string {
    const lines = [`#${structName}\t${csharpName}\t${kind}\n`];
    for (const [cName, field] of nameMembers(fields)) {
        if (cName !== field.name && !controlCharacters.test(field.name)) {
            lines.push(`.${structName}\t${cName}\t${field.name}\n`);
        }
    }

    return lines.join('');
}

/**
 * Writes the line of a struct of the runtime's metadata for the native engine's C# printer, with `m`, because C#
 * doesn't have a form for a class's or a method's metadata. The struct keeps its C name.
 */
export function writeMetadataLines(structName: string): string {
    return `#${structName}\t${structName}\tm\n`;
}

/**
 * Writes the lines of an array's struct for the native engine's C# printer, the array's C# name with `a` for the
 * struct of an array's objects, and the C# name of its length.
 */
export function writeArrayLines(structName: string, { csharpName }: ArrayStruct): string {
    return `#${structName}\t${csharpName}\ta\n.${structName}\t${arrayLength.member}\t${arrayLength.csharpName}\n`;
}
