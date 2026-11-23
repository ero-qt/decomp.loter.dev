import { read, type Node } from '@katana-project/asm';
import type {
    Annotation,
    AnnotationDefaultAttribute,
    AnnotationElementValue,
    AnnotationsAttribute,
    ArrayElementValue,
    Attributable,
    Attribute,
    BootstrapMethodsAttribute,
    ClassElementValue,
    CodeAttribute,
    ConstantValueAttribute,
    ElementValue,
    EnclosingMethodAttribute,
    EnumElementValue,
    InnerClass,
    InnerClassesAttribute,
    LocalVariableTableAttribute,
    ParameterAnnotationsAttribute,
    RecordAttribute,
    SignatureAttribute,
} from '@katana-project/asm/attr';
import type { ClassEntry, DynamicEntry, Entry, RefEntry, StringEntry, UTF8Entry } from '@katana-project/asm/pool';
import { ConstantType, ElementTag } from '@katana-project/asm/spec';
import { type Type, tryParseType } from '@katana-project/asm/type';
import type { Kind } from '../../contract/symbols';
import { access, readClassFlags, writeModifiers } from './flags';
import { findEndlessSwitch } from './switches';
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
    /** Whether the class is local or anonymous, which Java code only shows inside its outer class's code. */
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
 * Refuses a switch with a negative count first, because the reader loops on it until memory runs out.
 */
export function readClass(bytes: Uint8Array): Node {
    const endlessSwitch = findEndlessSwitch(bytes);
    if (endlessSwitch !== undefined) {
        throw new Error(`A method has ${endlessSwitch}.`);
    }

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

/** The members and classes that a class's code and declarations use. */
export interface ClassUses {
    /**
     * The keys of the members that the class uses, like `shapes/Shape#area#()D`, with the owner of the code's
     * reference.
     */
    members: Set<string>;
    /** The internal names of the classes that the class uses. */
    classes: Set<string>;
}

const memberRefTypes = new Set([ConstantType.FIELDREF, ConstantType.METHODREF, ConstantType.INTERFACE_METHODREF]);
const annotationAttributes = ['RuntimeVisibleAnnotations', 'RuntimeInvisibleAnnotations'];
const parameterAnnotationAttributes = ['RuntimeVisibleParameterAnnotations', 'RuntimeInvisibleParameterAnnotations'];

// returns the return descriptor of the annotation's method that an element's value is for, or `undefined` for an empty
// array because its value doesn't show the type of its items
function describeElement(value: ElementValue): string | undefined {
    switch (value.tag) {
        case ElementTag.STRING:
            return 'Ljava/lang/String;';
        case ElementTag.ENUM:
            return (value as EnumElementValue).typeNameEntry?.string;
        case ElementTag.CLASS:
            return 'Ljava/lang/Class;';
        case ElementTag.ANNOTATION:
            return (value as AnnotationElementValue).annotation.typeEntry?.string;
        case ElementTag.ARRAY: {
            const first = (value as ArrayElementValue).values[0];
            const item = first && describeElement(first);

            return item && `[${item}`;
        }
        default:
            return value.tag;
    }
}

/**
 * Reads the members that a class uses from the references in its pool and from the elements of its annotations. Reads
 * the classes that it uses from the classes in its pool, from its annotations and from the descriptors and generic
 * signatures of its own and its used members and locals.
 */
export function readUses(node: Node): ClassUses {
    const members = new Set<string>();
    const classes = new Set<string>();

    function addClasses(descriptor: string) {
        for (const [, name] of descriptor.matchAll(/L([^;<]+)[;<]/g)) {
            classes.add(name);
        }
    }

    function addValue(value: ElementValue) {
        if (value.tag === ElementTag.ENUM) {
            addClasses((value as EnumElementValue).typeNameEntry?.string ?? '');
        } else if (value.tag === ElementTag.CLASS) {
            addClasses((value as ClassElementValue).classInfoEntry?.string ?? '');
        } else if (value.tag === ElementTag.ANNOTATION) {
            addAnnotation((value as AnnotationElementValue).annotation);
        } else if (value.tag === ElementTag.ARRAY) {
            (value as ArrayElementValue).values.forEach(addValue);
        }
    }

    function addAnnotation({ typeEntry, values }: Annotation) {
        const type = typeEntry?.string ?? '';
        addClasses(type);

        for (const { nameEntry, value } of values) {
            const descriptor = describeElement(value);
            if (type.startsWith('L') && nameEntry && descriptor !== undefined) {
                members.add(`${type.slice(1, -1)}#${nameEntry.string}#()${descriptor}`);
            }

            addValue(value);
        }
    }

    function addDeclaration(holder: Attributable) {
        addClasses(findAttribute<SignatureAttribute>(holder, 'Signature')?.signatureEntry?.string ?? '');

        for (const name of annotationAttributes) {
            findAttribute<AnnotationsAttribute>(holder, name)?.annotations.forEach(addAnnotation);
        }
        for (const name of parameterAnnotationAttributes) {
            findAttribute<ParameterAnnotationsAttribute>(holder, name)?.parameters.flat().forEach(addAnnotation);
        }

        const defaultValue = findAttribute<AnnotationDefaultAttribute>(holder, 'AnnotationDefault')?.defaultValue;
        if (defaultValue) {
            addValue(defaultValue);
        }
    }

    function addLocals(holder: Attributable) {
        const code = findAttribute<CodeAttribute>(holder, 'Code');

        for (const name of ['LocalVariableTable', 'LocalVariableTypeTable']) {
            const table = code && findAttribute<LocalVariableTableAttribute>(code, name);
            table?.entries.forEach(entry => addClasses(entry.descriptorEntry?.string ?? ''));
        }
    }

    for (const entry of node.pool) {
        if (entry && memberRefTypes.has(entry.type)) {
            const { refEntry, nameTypeEntry } = entry as RefEntry;
            const owner = refEntry?.nameEntry?.string;
            const descriptor = nameTypeEntry?.typeEntry?.string;
            if (owner !== undefined && nameTypeEntry?.nameEntry && descriptor !== undefined) {
                members.add(`${owner}#${nameTypeEntry.nameEntry.string}#${descriptor}`);
                addClasses(descriptor);
            }
        } else if (entry?.type === ConstantType.CLASS) {
            const name = (entry as ClassEntry).nameEntry?.string;
            if (name?.startsWith('[')) {
                addClasses(name);
            } else if (name !== undefined) {
                classes.add(name);
            }
        }
    }

    for (const member of [...node.fields, ...node.methods]) {
        addClasses(member.type.string);
        addDeclaration(member);
        addLocals(member);
    }

    addDeclaration(node);
    findAttribute<RecordAttribute>(node, 'Record')?.components.forEach(addDeclaration);

    return { members, classes };
}

/** A string that a class's code loads or a constant field has. */
export interface ClassString {
    text: string;
    /** The key of the method or the field, like `drawing/Main#classify#(Lshapes/Shape;)Ljava/lang/String;`. */
    key: string;
}

const ldc = 0x12;
const ldcWide = 0x13;
const invokeDynamic = 0xba;
const stringConcatFactory = 'java/lang/invoke/StringConcatFactory';
// the characters that stand for an argument and a constant in a recipe of `StringConcatFactory`
const recipeMarkers = /[\u0001\u0002]/;

function readText(entry: Entry | null | undefined): string | undefined {
    return entry?.type === ConstantType.STRING ? (entry as StringEntry).dataEntry?.string : undefined;
}

/**
 * Reads the strings of the constant fields and the strings that each method's code loads, each once per method and
 * without empty strings. Splits a string concatenation's recipe into its constant parts. Leaves out the strings of
 * other bootstrap methods, like the component names that a record's `toString` gets.
 */
export function readStrings(node: Node, className: string): ClassString[] {
    const bootstrapMethods = findAttribute<BootstrapMethodsAttribute>(node, 'BootstrapMethods')?.methods ?? [];

    function readRecipes(entry: DynamicEntry | null): string[] {
        const method = entry ? bootstrapMethods[entry.bsmIndex] : undefined;
        if (method?.refEntry?.refEntry?.refEntry?.nameEntry?.string !== stringConcatFactory) {
            return [];
        }

        return method.args.flatMap(({ entry: argument }) => readText(argument)?.split(recipeMarkers) ?? []);
    }

    const fieldStrings = node.fields.flatMap(field => {
        const text = readText(findAttribute<ConstantValueAttribute>(field, 'ConstantValue')?.constEntry);

        return text ? [{ text, key: `${className}#${field.name.string}#${field.type.string}` }] : [];
    });

    const methodStrings = node.methods.flatMap(method => {
        const texts = new Set<string>();

        for (const { opcode, operands } of findAttribute<CodeAttribute>(method, 'Code')?.insns ?? []) {
            const index = opcode === ldc ? operands[0] : (operands[0] << 8) | operands[1];
            if (opcode === ldc || opcode === ldcWide) {
                const text = readText(node.pool[index]);
                if (text) {
                    texts.add(text);
                }
            } else if (opcode === invokeDynamic) {
                readRecipes(node.pool[index] as DynamicEntry | null).forEach(text => text && texts.add(text));
            }
        }

        return [...texts].map(text => ({ text, key: `${className}#${method.name.string}#${method.type.string}` }));
    });

    return [...fieldStrings, ...methodStrings];
}
