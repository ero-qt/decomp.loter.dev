import type { Member, Node } from '@katana-project/asm';
import type { BootstrapMethodsAttribute, CodeAttribute, RecordAttribute } from '@katana-project/asm/attr';
import type { DynamicEntry } from '@katana-project/asm/pool';
import { type MethodType, type Type, TypeKind } from '@katana-project/asm/type';
import { type ClassSymbols, findAttribute, findOwnEntry, parseSignature } from './classfile';
import { access, readFieldFlags, readMethodFlags } from './flags';
import { writeType } from './types';

/** A field or a method of a class. */
export interface MemberSymbols {
    /** The member's key, `<class>#<name>#<descriptor>`, like `drawing/Main#sum#([I)I`. */
    key: string;
    kind: 'field' | 'enum_member' | 'method' | 'constructor';
    /** The name in Java code, which is the class's short name for a constructor. */
    name: string;
    /** The parameter types of a method, like `(Shape, int...)`, or `''` for a field. */
    detail: string;
    flags: number;
    /** Whether Vineflower never writes the member, like a lambda's method or an enum's `values()`. */
    isHidden: boolean;
    /** The key of the record component's field whose accessor the method is, which writes the field's name in code. */
    aliasOf?: string;
}

const invokeDynamic = 0xba;
// the instructions of a record component's accessor that javac writes: `aload_0`, `getfield` and a return
const plainAccessorLength = 3;
const objectMethods = 'java/lang/runtime/ObjectMethods';

// checks whether a record's `toString`, `hashCode` or `equals` calls a bootstrap method of `ObjectMethods`, like the
// method that javac writes, because Vineflower leaves that method out
function usesObjectMethods(node: Node, method: Member): boolean {
    const bootstrapMethods = findAttribute<BootstrapMethodsAttribute>(node, 'BootstrapMethods')?.methods ?? [];
    const instructions = findAttribute<CodeAttribute>(method, 'Code')?.insns ?? [];

    return instructions.some(({ opcode, operands }) => {
        const entry = opcode === invokeDynamic ? (node.pool[(operands[0] << 8) | operands[1]] as DynamicEntry | null) : null;

        return entry !== null && bootstrapMethods[entry.bsmIndex]?.refEntry?.refEntry?.refEntry?.nameEntry?.string === objectMethods;
    });
}

/** What a class's methods share, read once per class because a class can have thousands of methods. */
interface MethodContext {
    node: Node;
    symbols: ClassSymbols;
    /**
     * The outer class whose instance an inner class's constructor takes first, for an inner class that isn't static.
     */
    takenOuter?: string;
    /** Record component name -> its descriptor. */
    components: Map<string, string>;
}

function readContext(node: Node, symbols: ClassSymbols): MethodContext {
    const own = findOwnEntry(node, symbols.name);
    const isInner = own?.outerEntry !== undefined && (own.innerAccess & access.static) === 0;
    const components = findAttribute<RecordAttribute>(node, 'Record')?.components ?? [];

    return {
        node,
        symbols,
        takenOuter: isInner ? own?.outerEntry?.nameEntry?.string : undefined,
        components: new Map(components.map(component => [component.nameEntry?.string ?? '', component.descriptorEntry?.string ?? ''])),
    };
}

// returns the key of the component's field for a record's accessor that only returns the field
function findComponentField({ symbols, components }: MethodContext, method: Member): string | undefined {
    const name = method.name.string;
    const descriptor = components.get(name);
    const instructions = findAttribute<CodeAttribute>(method, 'Code')?.insns ?? [];
    if (descriptor === undefined || method.type.string !== `()${descriptor}` || instructions.length !== plainAccessorLength) {
        return undefined;
    }

    return `${symbols.name}#${name}#${descriptor}`;
}

function isWrittenByJavac(node: Node, symbols: ClassSymbols, method: Member): boolean {
    const { name, keyword } = symbols;
    const signature = `${method.name.string}${method.type.string}`;
    if (keyword === 'enum') {
        return signature === `values()[L${name};` || signature === `valueOf(Ljava/lang/String;)L${name};`;
    }

    const isObjectMethod = ['toString()Ljava/lang/String;', 'hashCode()I', 'equals(Ljava/lang/Object;)Z'].includes(signature);

    return keyword === 'record' && isObjectMethod && usesObjectMethods(node, method);
}

// drops the outer class's instance that an inner class's constructor takes first, which Java code doesn't write
function listParameters({ takenOuter }: MethodContext, method: Member, type: MethodType): Type[] {
    const takesOuter = method.name.string === '<init>' && takenOuter !== undefined && type.parameters[0]?.value === `L${takenOuter};`;

    return takesOuter && !findAttribute(method, 'Signature') ? type.parameters.slice(1) : type.parameters;
}

function writeParameters(parameters: Type[], isVarargs: boolean): string {
    const texts = parameters.map(writeType);
    const last = parameters.at(-1);
    if (isVarargs && last?.kind === TypeKind.ARRAY) {
        texts[texts.length - 1] = texts.at(-1)!.replace(/\[\]$/, '...');
    }

    return `(${texts.join(', ')})`;
}

function readMethod(context: MethodContext, method: Member, key: string): MemberSymbols {
    const { node, symbols } = context;
    const name = method.name.string;
    const type = parseSignature(method, method.type.string) as MethodType | null;
    const parameters = type?.parameters ? listParameters(context, method, type) : [];

    const aliasOf = symbols.keyword === 'record' ? findComponentField(context, method) : undefined;
    const isHidden = (method.access & (access.synthetic | access.bridge)) !== 0 || name === '<clinit>' || aliasOf !== undefined;

    const hasCode = findAttribute(method, 'Code') !== undefined;
    const shownName = name === '<init>' ? symbols.shortName : name;
    const detail = writeParameters(parameters, (method.access & access.varargs) !== 0);
    const flags = readMethodFlags(method.access, (node.access & access.interface) !== 0, hasCode);

    return {
        key,
        kind: name === '<init>' ? 'constructor' : 'method',
        name: shownName,
        detail,
        flags,
        isHidden: isHidden || isWrittenByJavac(node, symbols, method),
        aliasOf,
    };
}

/** Reads the fields, then the methods of a class in the class file's order. */
export function readMembers(node: Node, symbols: ClassSymbols): MemberSymbols[] {
    const fields = node.fields.map((field): MemberSymbols => {
        const name = field.name.string;
        const flags = readFieldFlags(field.access);

        return {
            key: `${symbols.name}#${name}#${field.type.string}`,
            kind: field.access & access.enum ? 'enum_member' : 'field',
            name,
            detail: '',
            flags,
            isHidden: (field.access & access.synthetic) !== 0,
        };
    });

    const context = readContext(node, symbols);
    const methods = node.methods.map(method => readMethod(context, method, `${symbols.name}#${method.name.string}#${method.type.string}`));

    return [...fields, ...methods];
}
