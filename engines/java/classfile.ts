import { read, type Node } from '@katana-project/asm';
import type {
    Attributable,
    Attribute,
    CodeAttribute,
    EnclosingMethodAttribute,
    InnerClass,
    InnerClassesAttribute,
    LocalVariableTableAttribute,
    RecordAttribute,
    SignatureAttribute,
} from '@katana-project/asm/attr';
import type { UTF8Entry } from '@katana-project/asm/pool';
import { ConstantType } from '@katana-project/asm/spec';
import { type Type, tryParseType } from '@katana-project/asm/type';
import type { Kind } from '../../contract/symbols';
import { access, readClassFlags, writeModifiers } from './flags';
import { writeType, writeTypeParameters } from './types';

export type ClassKeyword = 'class' | 'interface' | 'enum' | 'record' | '@interface';

/** What the engine reads of a class file to list and open it. */
export interface ClassSymbols {
    /** The internal name, like `drawing/Main$Entry`. */
    name: string;
    /** The name in Java code without the outer classes, like `Entry`. */
    shortName: string;
    /** The internal name of the class that contains a nested, local or anonymous class. */
    outer?: string;
    /** Whether the class is local or anonymous, which Java code shows only inside its outer class's code. */
    isHidden: boolean;
    isModule: boolean;
    keyword: ClassKeyword;
    /** The access flags, from the class's own entry in `InnerClasses` for a nested class. */
    access: number;
    superName?: string;
    interfaces: string[];
    kind: Kind;
    /** The flags of the class's row, without `document`. */
    flags: number;
    /** The class's declaration in Java code, like `public record Circle(double radius)`. */
    signature: string;
    /** The descriptor of a record's canonical constructor, which takes the components in their order. */
    recordConstructor?: string;
}

// keyword -> the kind of the class's row
const classKinds: Record<ClassKeyword, Kind> = {
    class: 'class',
    interface: 'interface',
    enum: 'enum',
    record: 'record',
    '@interface': 'annotation',
};

const utf16Decoder = new TextDecoder('utf-16le');

// reads each byte sequence as 1 UTF-16 code unit because modified UTF-8 writes a character outside the BMP as 2
// surrogates of 3 bytes each, which `TextDecoder` reads as replacement characters
function decodeModifiedUtf8(bytes: Uint8Array): string {
    const units: number[] = [];

    for (let index = 0; index < bytes.length; ) {
        const byte = bytes[index];
        if (byte < 0x80) {
            units.push(byte);
            index += 1;
        } else if (byte < 0xe0) {
            units.push(((byte & 0x1f) << 6) | (bytes[index + 1] & 0x3f));
            index += 2;
        } else {
            units.push(((byte & 0x0f) << 12) | ((bytes[index + 1] & 0x3f) << 6) | (bytes[index + 2] & 0x3f));
            index += 3;
        }
    }

    return utf16Decoder.decode(Uint16Array.from(units));
}

/**
 * Reads a class file and decodes again each text with a surrogate or the character 0, which the reader decodes wrong.
 */
export function readClass(bytes: Uint8Array): Node {
    const node = read(bytes);

    for (const entry of node.pool) {
        if (entry?.type === ConstantType.UTF8) {
            const text = entry as UTF8Entry;
            if (text.bytes.includes(0xed) || text.bytes.includes(0xc0)) {
                text.string = decodeModifiedUtf8(text.bytes);
            }
        }
    }

    return node;
}

/** Finds a class's, member's or attribute's attribute by name, typed as the attribute that the reader parses for it. */
export function findAttribute<Found extends Attribute>(holder: Attributable, name: string): Found | undefined {
    return holder.attrs.find(found => found.name?.string === name) as Found | undefined;
}

function readKeyword(node: Node): ClassKeyword {
    if (node.access & access.annotation) {
        return '@interface';
    }
    if (node.access & access.interface) {
        return 'interface';
    }
    if (node.access & access.enum) {
        return 'enum';
    }

    return node.superClass?.nameEntry?.string === 'java/lang/Record' ? 'record' : 'class';
}

/** Finds a class's own entry in its `InnerClasses` attribute, which a nested, local or anonymous class has. */
export function findOwnEntry(node: Node, name: string): InnerClass | undefined {
    const classes = findAttribute<InnerClassesAttribute>(node, 'InnerClasses')?.classes ?? [];

    return classes.find(inner => inner.innerEntry?.nameEntry?.string === name);
}

/** Parses the generic signature of a class or a member, or its descriptor when it doesn't have one. */
export function parseSignature(holder: Attributable, descriptor: string): Type | null {
    const signature = findAttribute<SignatureAttribute>(holder, 'Signature')?.signatureEntry?.string;

    return (signature && tryParseType(signature)) || tryParseType(descriptor);
}

// writes a record's components, like `(double radius)`, or `''` for a class that isn't a record
function writeComponents(node: Node): string {
    const components = findAttribute<RecordAttribute>(node, 'Record')?.components;
    const texts = components?.map(component => {
        const type = parseSignature(component, component.descriptorEntry?.string ?? '');

        return `${type ? writeType(type) : '?'} ${component.nameEntry?.string ?? ''}`;
    });

    return texts ? `(${texts.join(', ')})` : '';
}

// leaves out the modifiers that Java code doesn't write for an enum or a record, which are always final
function writeClassSignature(node: Node, keyword: ClassKeyword, flags: number, shortName: string): string {
    const modifiers = writeModifiers(flags, keyword === 'enum' || keyword === 'record' ? ['final', 'abstract'] : []);

    return `${modifiers}${keyword} ${shortName}${writeTypeParameters(parseSignature(node, ''))}${writeComponents(node)}`;
}

function readRecordConstructor(node: Node): string | undefined {
    const components = findAttribute<RecordAttribute>(node, 'Record')?.components;

    return components && `(${components.map(component => component.descriptorEntry?.string ?? '').join('')})V`;
}

/** Reads what the engine needs of a class file to list and open it. */
export function readSymbols(node: Node): ClassSymbols {
    const name = node.thisClass.nameEntry!.string;
    const own = findOwnEntry(node, name);
    const keyword = readKeyword(node);
    const flags = own ? own.innerAccess : node.access;
    const shortName = own?.innerNameEntry?.string ?? name.slice(name.lastIndexOf('/') + 1);
    const rowFlags = readClassFlags(flags, findAttribute(node, 'PermittedSubclasses') !== undefined);

    return {
        name,
        shortName,
        outer: own?.outerEntry?.nameEntry?.string ?? findAttribute<EnclosingMethodAttribute>(node, 'EnclosingMethod')?.classEntry?.nameEntry?.string,
        isHidden: own !== undefined && !own.outerEntry,
        isModule: (node.access & access.module) !== 0,
        keyword,
        access: flags,
        superName: node.superClass?.nameEntry?.string,
        interfaces: node.interfaces.flatMap(entry => entry.nameEntry?.string ?? []),
        kind: classKinds[keyword],
        flags: rowFlags,
        signature: writeClassSignature(node, keyword, rowFlags, shortName),
        recordConstructor: readRecordConstructor(node),
    };
}

/**
 * Finds the declared type of a method's parameter or local in the method's tables of locals, which javac writes with
 * debug information, the generic type first. Takes the type of the name alone when Vineflower's index differs from the
 * table's index and every local with the name has that type. Returns `null` for a local without debug information.
 */
export function findLocalType(node: Node, method: string, descriptor: string, index: number, name: string): string | null {
    const found = node.methods.find(member => member.name.string === method && member.type.string === descriptor);
    const code = found && findAttribute<CodeAttribute>(found, 'Code');

    for (const tableName of ['LocalVariableTypeTable', 'LocalVariableTable']) {
        const table = code && findAttribute<LocalVariableTableAttribute>(code, tableName);
        const named = table?.entries.filter(entry => entry.nameEntry?.string === name && entry.descriptorEntry) ?? [];
        const hasOneType = new Set(named.map(entry => entry.descriptorEntry!.string)).size === 1;
        const local = named.find(entry => entry.index === index) ?? (hasOneType ? named[0] : undefined);
        const type = local && tryParseType(local.descriptorEntry!.string);
        if (type) {
            return writeType(type);
        }
    }

    return null;
}
