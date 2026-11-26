import { type Document, formatTarget, type Token, writeTokens } from '#contract/document';
import { failed, ok, type Reply } from '#contract/reply';
import { flagsOf, type Kind } from '#contract/symbols';
import { maxImageSpan } from './keys';
import type { NativeModule } from './module';

/** A part of Ghidra's C as rz-ghidra annotates it, with UTF-8 offsets and its address in hex. */
export interface Annotation {
    start: number;
    end: number;
    type: string;
    syntax_highlight?: string;
    name?: string;
    offset?: string;
    /** The index of the method that a call of shared code reads as, among the methods that share the code. */
    sharer?: number;
}

/**
 * The C of a function with its annotations like `pdgj` writes them, or the decompiler's errors. C# code also has the
 * links of the parts that name a type, a field, a called function's declaring type, a called accessor's property or the
 * class of a raised exception, each with the struct's name, the function's address or the class's name.
 */
export interface Decompiled {
    code?: string;
    annotations?: Annotation[];
    links?: Annotation[];
    errors?: string[];
}

/**
 * Writes the target of a link of C# code, which only the engine that gave the names of the code can resolve, as a
 * symbol outside the open files, `|#type:<struct>`, `|#field:<struct>:<offset in hex>`,
 * `|#declaring_type:<key of the function's row in hex>`, `|#property:<key of the accessor's row in hex>`,
 * `|#sharer:<key of the function's row in hex>:<index of the method>`, `|#sharer_type:` with the same places or
 * `|#raised_type:<name of the exception's class>`.
 */
function formatLinkTarget({ type, name, offset, sharer }: Annotation, rows: CodeRows): string {
    const address = BigInt(offset ?? 0);
    const writePlace = () => {
        const key = (rows.findRow(address)?.key ?? 0).toString(16);
        switch (type) {
            case 'type':
            case 'raised_type':
                return name;
            case 'field':
                return `${name}:${address.toString(16)}`;
            case 'sharer':
            case 'sharer_type':
                return `${key}:${sharer ?? 0}`;
            default:
                return key;
        }
    };

    return formatTarget({ outside: `#${type}:${writePlace()}` });
}

/** The rows of the function's file, which the C's tokens point at. */
export interface CodeRows {
    fileId: number;
    /** The address of the decompiled function, whose name in the signature declares its row. */
    address: bigint;
    /**
     * Returns the key and kind of the row of a function or global at an address, or `undefined` without a row. A row
     * without a kind takes the kind of its token's annotation.
     */
    findRow(address: bigint): { key: number; kind?: Kind } | undefined;
}

// a part of the C with UTF-16 offsets and the highlight, name and address of its annotations
interface Part {
    start: number;
    end: number;
    highlight: string;
    name?: string;
    address?: bigint;
    /** The link of C# code that starts with the part. */
    link?: Annotation;
}

const encoder = new TextEncoder();
// the text that the cache of documents keeps, about 32 MB in UTF-16
const maxCachedChars = 16 * 1024 * 1024;
// the largest function that the engine decompiles, because Ghidra takes 6 s for a function of 62 KB and longer for a
// larger one
const maxFunctionBytes = 64 * 1024;
const declaration = flagsOf('', 'declaration');

// converts the offsets of UTF-8 bytes in a text to offsets of UTF-16 code units, which the page counts in
function readUtf16Offsets(text: string): (offset: number) => number {
    if (!/[^\x00-\x7f]/.test(text)) {
        return offset => offset;
    }

    const offsets: number[] = [];
    let index = 0;
    for (const character of text) {
        offsets.push(...new Array<number>(encoder.encode(character).length).fill(index));
        index += character.length;
    }
    offsets.push(index);

    return offset => offsets[offset];
}

// reads the highlighted parts and the names and addresses that other annotations of the same start give them, with
// the links of C# code, each on the highlighted part of its start or as a part of its own
function readParts(code: string, annotations: Annotation[], links: Annotation[]): Part[] {
    const toUtf16 = readUtf16Offsets(code);
    const details = new Map<number, Annotation>();
    for (const annotation of annotations) {
        if (annotation.name !== undefined || annotation.type === 'global_variable') {
            details.set(annotation.start, annotation);
        }
    }

    const linksByStart = new Map(links.map(link => [link.start, link]));
    const highlighted = annotations
        .filter(({ type, syntax_highlight }) => type === 'syntax_highlight' && syntax_highlight !== undefined)
        .map(({ start, end, syntax_highlight }): Part => {
            const { name, offset } = details.get(start) ?? {};
            const address = offset === undefined ? undefined : BigInt(offset);
            const link = linksByStart.get(start);
            linksByStart.delete(start);

            return { start: toUtf16(start), end: toUtf16(end), highlight: syntax_highlight!, name, address, link };
        });
    const linked = [...linksByStart.values()].map((link): Part => ({ start: toUtf16(link.start), end: toUtf16(link.end), highlight: '', link }));

    return [...highlighted, ...linked].sort((first, second) => first.start - second.start);
}

// moves the comments that Ghidra writes in front of a function to 1 block at its end, so the text starts with the
// signature, and shifts the parts by the cut
function moveWarnings(code: string, parts: Part[]): { text: string; parts: Part[] } {
    const warnings: string[] = [];
    let start = 0;
    for (const part of parts) {
        // skips the other words of a comment, because Ghidra marks each word of a warning as a comment
        if (part.start < start) {
            continue;
        }
        if (part.highlight !== 'comment' || code.slice(start, part.start).trim() !== '') {
            break;
        }

        const lineEnd = code.indexOf('\n', part.end);
        warnings.push(code.slice(part.start, lineEnd < 0 ? code.length : lineEnd).trim());
        start = lineEnd < 0 ? code.length : lineEnd + 1;
    }

    const body = code.slice(start).replace(/^\s+/, '').trimEnd();
    const shift = code.length - code.slice(start).replace(/^\s+/, '').length;
    const text = warnings.length > 0 ? `${body}\n\n${warnings.join('\n')}\n` : `${body}\n`;
    const moved = parts.filter(part => part.start >= shift).map(part => ({ ...part, start: part.start - shift, end: part.end - shift }));

    return { text, parts: moved };
}

// returns a variable's declaration as its type and name, like `int width`, from the last type before it on its line
function describeVariable(text: string, parts: Part[], variable: Part): string {
    const lineStart = text.lastIndexOf('\n', variable.start) + 1;
    const type = parts.findLast(({ highlight, start }) => highlight === 'datatype' && start >= lineStart && start < variable.start);

    return text.slice(type?.start ?? variable.start, variable.end).replace(/\s+/g, ' ');
}

/**
 * Turns Ghidra's C with rz-ghidra's annotations into a document. The function's name in the signature declares the function's row.
 * A call points at its callee's row. Parameters, locals and the labels that a `goto` jumps to are locals of the
 * document, declared at their first token. A type is colored without a target. A link of C# code has the target of
 * `formatLinkTarget`.
 */
export function writeCode(code: string, annotations: Annotation[], rows: CodeRows, links: Annotation[] = []): Document {
    const { text, parts } = moveWarnings(code, readParts(code, annotations, links));
    const tokens: Token[] = [];
    const locals: string[] = [];
    // name of a variable or label -> its number in `locals`
    const localNumbers = new Map<string, number>();
    let isDeclared = false;

    function addLocal(name: string, describe: () => string): { target: string; flags: number } {
        const known = localNumbers.get(name);
        if (known !== undefined) {
            return { target: `L:${known}`, flags: 0 };
        }

        localNumbers.set(name, locals.push(describe()) - 1);

        return { target: `L:${locals.length - 1}`, flags: declaration };
    }

    function addRowToken(part: Part, fallback: Kind) {
        const row = part.address === undefined ? undefined : rows.findRow(part.address);
        const target = row ? formatTarget({ fileId: rows.fileId, key: row.key }) : null;
        const isDeclaration = !isDeclared && part.highlight === 'function_name' && part.address === rows.address;
        isDeclared ||= isDeclaration;
        const flags = isDeclaration ? declaration : 0;
        tokens.push({ start: part.start, length: part.end - part.start, kind: row?.kind ?? fallback, flags, target });
    }

    for (const part of parts) {
        const length = part.end - part.start;
        if (part.link) {
            const kinds: Record<string, Kind> = { field: 'field', property: 'property', sharer: 'method' };
            const kind = kinds[part.link.type] ?? 'class';
            tokens.push({ start: part.start, length, kind, flags: 0, target: formatLinkTarget(part.link, rows) });
        } else if (part.highlight === 'function_name') {
            addRowToken(part, 'method');
        } else if (part.highlight === 'global_variable' || (part.address !== undefined && part.highlight === 'local_variable')) {
            addRowToken(part, 'field');
        } else if (part.highlight === 'datatype' && part.address !== undefined) {
            // the type that a global of C# code names, like the class of a `new` expression
            addRowToken(part, 'class');
        } else if ((part.highlight === 'function_parameter' || part.highlight === 'local_variable') && part.name !== undefined) {
            const kind = part.highlight === 'function_parameter' ? 'parameter' : 'local';
            tokens.push({ start: part.start, length, kind, ...addLocal(part.name, () => describeVariable(text, parts, part)) });
        } else if (part.highlight === 'datatype') {
            tokens.push({ start: part.start, length, kind: 'struct', flags: 0, target: null });
        } else if (part.highlight === 'keyword' && text.slice(part.start, part.end) === 'goto') {
            addLabel(text, part.end, tokens, addLocal);
        }
    }

    tokens.sort((first, second) => first.start - second.start);

    return writeTokens(text, tokens.filter((token, index) => index === 0 || token.start !== tokens[index - 1].start), locals);
}

// adds the label after a `goto`, which Ghidra writes without an annotation, and the label's line, which declares it
function addLabel(
    text: string,
    after: number,
    tokens: Token[],
    addLocal: (name: string, describe: () => string) => { target: string; flags: number },
) {
    const label = /^\s*(loc_[0-9a-f]+)\b/.exec(text.slice(after));
    const definition = label ? text.indexOf(`\n${label[1]}:`) + 1 : 0;
    if (!label || definition === 0) {
        return;
    }

    const name = label[1];
    const use = after + label[0].length - name.length;
    const declared = addLocal(name, () => name);
    tokens.push({ start: definition, length: name.length, kind: 'label', flags: declaration, target: declared.target });
    tokens.push({ start: use, length: name.length, kind: 'label', flags: 0, target: declared.target });
}

/**
 * Writes the document of a function that is too large to decompile: its prototype, whose name declares its row, and a
 * line with the size of its code.
 */
export function writePrototype(signature: string, name: string, size: number, rows: CodeRows, kind: Kind): Document {
    const prototype = `${signature.replace(/;$/, '')};`;
    // finds the name before the parameters, because the return type can have the same word
    const parameters = prototype.indexOf('(');
    const start = Math.max(0, prototype.lastIndexOf(name, parameters < 0 ? undefined : parameters - name.length));
    const row = rows.findRow(rows.address);
    const target = row ? formatTarget({ fileId: rows.fileId, key: row.key }) : null;
    const token: Token = { start, length: name.length, kind, flags: declaration, target };

    return writeTokens(`${prototype}\n// ${size.toLocaleString('en')} bytes of code, more than the engine decompiles.\n`, [token], []);
}

/**
 * Decompiles the function at the address of `rows` in a session whose processor's languages are written, or writes its
 * prototype when its code is too large. Refuses an address without a function and a function that Ghidra can't
 * decompile.
 */
export function decompileFunction(module: NativeModule, session: number, kind: Kind, rows: CodeRows, isCSharp = false): Reply<Document> {
    const prepared = module.prepareFunction(session, rows.address);
    if (!prepared) {
        return failed(`Rizin doesn't find a function at 0x${rows.address.toString(16)}.`);
    }
    if (prepared.size > maxFunctionBytes) {
        return ok(writePrototype(prepared.signature, prepared.name, prepared.size, rows, kind));
    }

    const decompile = isCSharp ? module.decompileCSharp : module.decompile;
    const { code, annotations = [], links = [], errors = [] } = decompile(session, BigInt(prepared.addr));
    if (typeof code !== 'string') {
        return failed(errors.join(' ') || `Ghidra can't decompile the function at ${prepared.addr}.`);
    }

    return ok(writeCode(code, annotations, rows, links));
}

/**
 * Decompiles the code at an address relative to the image like `decompileFunction`, without the file's rows, because
 * the rows stop at a cap that a game's binary passes. Each target's key is its address relative to the image, which is
 * the key of its row in an image that spans less than 2 GB. Writes C# with `isCSharp`.
 */
export function decompileAt(module: NativeModule, session: number, fileId: number, base: bigint, rva: number, isCSharp = false): Reply<Document> {
    const rows: CodeRows = {
        fileId,
        address: base + BigInt(rva),
        findRow: address => (address >= base && address - base < maxImageSpan ? { key: Number(address - base) } : undefined),
    };

    return decompileFunction(module, session, 'method', rows, isCSharp);
}

/** The documents of decompiled functions by file and key, which drops the documents read longest ago. */
export interface DocumentCache {
    get(fileId: number, key: number): Document | undefined;
    set(fileId: number, key: number, document: Document): void;
    dropFile(fileId: number): void;
}

/**
 * Returns an empty cache of documents with room for about 32 MB of text. A read after a canceled read of a class then
 * takes the methods that the canceled read wrote, and a second read costs nothing.
 */
export function createDocumentCache(): DocumentCache {
    const documents = new Map<string, Document>();
    let chars = 0;

    function drop(id: string) {
        chars -= documents.get(id)?.text.length ?? 0;
        documents.delete(id);
    }

    return {
        get(fileId, key) {
            const id = `${fileId}:${key}`;
            const document = documents.get(id);
            if (document) {
                documents.delete(id);
                documents.set(id, document);
            }

            return document;
        },
        set(fileId, key, document) {
            const id = `${fileId}:${key}`;
            drop(id);
            documents.set(id, document);
            chars += document.text.length;
            for (const oldest of documents.keys()) {
                if (chars <= maxCachedChars || oldest === id) {
                    break;
                }

                drop(oldest);
            }
        },
        dropFile(fileId) {
            for (const id of [...documents.keys()].filter(id => id.startsWith(`${fileId}:`))) {
                drop(id);
            }
        },
    };
}
