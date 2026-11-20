import {
    type ArrayType,
    type ClassType,
    type MethodType,
    type ParameterizedType,
    type Type,
    TypeKind,
    type TypeParameter,
    type TypeVariable,
    WildcardBoundType,
    type WildcardType,
} from '@katana-project/asm/type';

/**
 * Writes an internal class name without its package and with a `.` for each `$`, like `Main.Entry` for
 * `drawing/Main$Entry`.
 */
export function simpleName(name: string): string {
    return name.slice(name.lastIndexOf('/') + 1).replaceAll('$', '.');
}

function isObject(type: Type): boolean {
    return type.kind === TypeKind.OBJECT && type.value === 'Ljava/lang/Object;';
}

// the most levels of a generic type that the engine writes, because a hostile signature can nest types deep enough to
// overflow the stack
const maxTypeDepth = 100;

function writeWildcard({ boundType, bound }: WildcardType, depth: number): string {
    if (boundType === WildcardBoundType.UNBOUNDED || !bound) {
        return '?';
    }

    return `? ${boundType === WildcardBoundType.EXTENDS ? 'extends' : 'super'} ${writeNested(bound, depth)}`;
}

function writeNested(type: Type, depth: number): string {
    if (depth > maxTypeDepth) {
        throw new Error(`The engine can't write a type nested more than ${maxTypeDepth} levels deep.`);
    }

    const writeInner = (inner: Type) => writeNested(inner, depth + 1);

    switch (type.kind) {
        case TypeKind.OBJECT:
            return simpleName(type.value.slice(1, -1));
        case TypeKind.ARRAY: {
            const { elementType, dimensions } = type as ArrayType;

            return `${writeInner(elementType)}${'[]'.repeat(dimensions)}`;
        }
        case TypeKind.TYPE_VARIABLE:
            return (type as TypeVariable).identifier;
        case TypeKind.TYPE_PARAMETER: {
            const { identifier, classBound, interfaceBounds = [] } = type as TypeParameter;
            const bounds = [classBound, ...interfaceBounds].filter((bound): bound is Type => bound !== undefined && !isObject(bound));

            return bounds.length > 0 ? `${identifier} extends ${bounds.map(writeInner).join(' & ')}` : identifier;
        }
        case TypeKind.PARAMETERIZED: {
            const { rawType, typeArguments } = type as ParameterizedType;

            return `${writeInner(rawType)}<${typeArguments.map(writeInner).join(', ')}>`;
        }
        case TypeKind.WILDCARD:
            return writeWildcard(type as WildcardType, depth + 1);
        default:
            return type.name;
    }
}

/**
 * Writes a type of a descriptor or a generic signature the way Java writes it, with simple class names. Writes
 * wildcards itself because the reader writes them like `? 2 T`. Throws for a type nested more than 100 levels deep.
 */
export function writeType(type: Type): string {
    return writeNested(type, 0);
}

/** Writes the type parameters of a generic class or method, like `<T>`, or `''` for a type without them. */
export function writeTypeParameters(type: Type | null): string {
    const parameters = (type as ClassType | MethodType | null)?.typeParameters ?? [];

    return parameters.length > 0 ? `<${parameters.map(writeType).join(', ')}>` : '';
}
