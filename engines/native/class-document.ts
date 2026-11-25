import { type Document, formatTarget, readTokens, type Token, writeTokens } from '#contract/document';
import { ok, type Reply } from '#contract/reply';
import type { Row } from '#contract/rows';
import { flagsOf, type Kind } from '#contract/symbols';
import type { NativeRows } from './rows';

/** A static data member of a class, which the class's document declares. */
export interface StaticMember {
    name: string;
    key: number;
    address: bigint;
    size: number;
}

/** A method of a class, whose name its class's document shows when the method can't be decompiled. */
export interface ClassMethod {
    key: number;
    name: string;
    kind: Kind;
}

/** The definition or name, the static members and the methods of a class, which its document shows. */
export interface ClassParts {
    fileId: number;
    key: number;
    /** The class's name with its outer scopes, like `geometry::Rect`. */
    fullName: string;
    /** The struct's name and C definition from the debug information, or `undefined` without one. */
    definition: { name: string; text: string } | undefined;
    statics: StaticMember[];
    /** The methods in address order. */
    methods: ClassMethod[];
}

/** How a view writes a class's header, which is C code in the C view and comment lines in the Assembly view. */
export interface HeaderStyle {
    /** The text in front of each line of the class's definition and static members, like `; `. */
    linePrefix: string;
    /** The text in front of a comment, like `// `. */
    comment: string;
}

/** Writes the header as C code with C comments. */
export const cHeader: HeaderStyle = { linePrefix: '', comment: '// ' };

/** Writes the header as assembly comments, which the assembly grammar colors as comments. */
export const assemblyHeader: HeaderStyle = { linePrefix: '; ', comment: '; ' };

const declaration = flagsOf('', 'declaration');

/** Returns a global's type from its size like Ghidra does, because the debug information doesn't give its type. */
export function describeType(size: number): string {
    return [1, 2, 4, 8].includes(size) ? `undefined${size}` : 'undefined';
}

// writes the class's definition, else a comment with its name, and a line for each static member
function writeHeader({ fileId, key, fullName, definition, statics }: ClassParts, { linePrefix, comment }: HeaderStyle): Document {
    const tokens: Token[] = [];
    let text: string;
    if (definition) {
        text = definition.text.replace(/^\t+/gm, tabs => '    '.repeat(tabs.length)).replace(/^(?=.)/gm, linePrefix);
        const start = text.indexOf(`struct ${definition.name}`) + 'struct '.length;
        tokens.push({ start, length: definition.name.length, kind: 'class', flags: declaration, target: formatTarget({ fileId, key }) });
    } else {
        text = `${comment}class ${fullName}\n`;
        const target = formatTarget({ fileId, key });
        tokens.push({ start: `${comment}class `.length, length: fullName.length, kind: 'class', flags: declaration, target });
    }

    for (const member of statics) {
        const name = `${fullName}::${member.name}`;
        const prefix = `${linePrefix}extern ${describeType(member.size)} `;
        const target = formatTarget({ fileId, key: member.key });
        tokens.push({ start: text.length + prefix.length, length: name.length, kind: 'field', flags: declaration, target });
        text += `${prefix}${name}; // 0x${member.address.toString(16)}\n`;
    }

    return writeTokens(text, tokens, []);
}

// joins documents with a blank line between each 2 and numbers each document's locals after the locals before it
function joinDocuments(documents: Document[]): Document {
    const tokens: Token[] = [];
    const locals: string[] = [];
    let text = '';
    for (const document of documents) {
        if (text !== '') {
            text += '\n';
        }

        for (const token of readTokens(document)) {
            const local = token.target?.startsWith('L:') ? Number(token.target.slice(2)) : undefined;
            const target = local === undefined ? token.target : `L:${local + locals.length}`;
            tokens.push({ ...token, start: token.start + text.length, target });
        }

        text += document.text;
        locals.push(...document.locals);
    }

    return writeTokens(text, tokens, locals);
}

/**
 * Collects what the document of the class row at an index shows. Takes the definition of the struct with the class's
 * full name, else with its own name, because the debug information can leave the outer scopes out.
 */
export function listClassParts(
    { rows, keys, sizes }: NativeRows,
    index: number,
    fileId: number,
    describeStruct: (name: string) => string | undefined,
): ClassParts {
    const names: string[] = [];
    for (let at = index; at >= 0; at = rows[at].parent) {
        names.unshift(rows[at].name);
    }

    const fullName = names.join('::');
    const members = rows.filter(row => row.parent === index && keys.addresses.has(row.key));
    const statics = members.filter(row => row.kind === 'field').map(({ name, key }: Row) => {
        return { name, key, address: keys.addresses.get(key)!, size: sizes.get(key) ?? 0 };
    });
    const methods = members.filter(row => row.kind !== 'field').map(({ key, name, kind }) => ({ key, name, kind }));

    let definition: ClassParts['definition'];
    for (const name of [fullName, rows[index].name]) {
        const text = describeStruct(name);
        if (text !== undefined) {
            definition = { name, text };
            break;
        }
    }

    return { fileId, key: rows[index].key, fullName, definition, statics, methods };
}

// writes a comment with the error of a method that the view can't write, whose name declares the method's row
function writeFailedMethod({ fileId, fullName }: ClassParts, { key, name, kind }: ClassMethod, error: string, comment: string): Document {
    const fullMethodName = `${fullName}::${name}`;
    const token: Token = { start: comment.length, length: fullMethodName.length, kind, flags: declaration, target: formatTarget({ fileId, key }) };

    return writeTokens(`${comment}${fullMethodName}: ${error}\n`, [token], []);
}

/**
 * Writes a class's document with the class's definition or name, a line for each static member, then each method's
 * document from `readMethod` in address order. Reads 1 method per call of `readMethod` and yields to other tasks after
 * each method, so a cancel stops the document between 2 methods. A method that the view can't write gets a comment
 * with the error.
 */
export async function writeClassDocument(
    parts: ClassParts,
    readMethod: (key: number) => Reply<Document> | Promise<Reply<Document>>,
    signal: AbortSignal,
    style: HeaderStyle = cHeader,
): Promise<Reply<Document>> {
    const documents = [writeHeader(parts, style)];
    for (const method of parts.methods) {
        signal.throwIfAborted();
        const read = await readMethod(method.key);
        documents.push(read.error === undefined ? read.value : writeFailedMethod(parts, method, read.error, style.comment));
        await new Promise(resolve => setTimeout(resolve));
    }

    signal.throwIfAborted();

    return ok(joinDocuments(documents));
}
