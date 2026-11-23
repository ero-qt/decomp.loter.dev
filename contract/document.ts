import { type Kind, kinds } from './symbols';

/** A colored part of a line of a document's text, like the name of a symbol. */
export interface Token {
    /** The start in the text, in UTF-16 code units like the length. */
    start: number;
    length: number;
    kind: Kind;
    flags: number;
    /** The target of the symbol of the token, or `null` for a token without one. */
    target: string | null;
}

/**
 * A document as an engine sends it, with 5 values for each token: start, length, kind, flags and the index of its
 * target or -1.
 */
export interface Document {
    /** The text, with `\n` at the end of each line. */
    text: string;
    tokens: Int32Array;
    targets: string[];
    /** The declaration of each symbol that only this document has, at the number of its `L:<number>` target. */
    locals: string[];
    /** Whether the engine still writes parts of the document, so the page reads the document again. */
    isPartial?: boolean;
}

/**
 * The symbol that a token points at. As a text, a row of an open file is `<fileId>:<key in hex>`, a symbol that only
 * the document of the token has is `L:<number>` and a symbol outside the open files is `|<text>`.
 */
export type Target = { fileId: number; key: number } | { local: number } | { outside: string };

const valuesPerToken = 5;

export function writeTokens(text: string, tokens: Token[], locals: string[]): Document {
    const targetIndexes = new Map<string, number>();
    const values = new Int32Array(tokens.length * valuesPerToken);
    tokens.forEach(({ start, length, kind, flags, target }, index) => {
        let targetIndex = -1;
        if (target !== null) {
            targetIndex = targetIndexes.get(target) ?? targetIndexes.size;
            targetIndexes.set(target, targetIndex);
        }
        values.set([start, length, kinds.indexOf(kind), flags, targetIndex], index * valuesPerToken);
    });

    return { text, tokens: values, targets: [...targetIndexes.keys()], locals };
}

function parseTokenTarget(target: string, index: number): Target {
    try {
        return parseTarget(target);
    } catch {
        throw new Error(`token ${index} has the target '${target}', which isn't a target`);
    }
}

/**
 * Reads the tokens that an engine sent and throws for a document that breaks the layout, like a token past the end of
 * the text or across a line end, or a text whose last line doesn't end with a line end.
 */
export function readTokens({ text, tokens, targets, locals }: Document): Token[] {
    if (tokens.length % valuesPerToken !== 0) {
        throw new Error(`${tokens.length} values aren't ${valuesPerToken} for each token`);
    }
    if (text.includes('\r')) {
        throw new Error(`the text has a carriage return at ${text.indexOf('\r')}`);
    }
    if (text !== '' && !text.endsWith('\n')) {
        throw new Error("the text doesn't end with a line end");
    }

    const read: Token[] = [];
    for (let index = 0; index * valuesPerToken < tokens.length; index++) {
        const [start, length, kindNumber, flags, targetIndex] = tokens.subarray(index * valuesPerToken, (index + 1) * valuesPerToken);
        const kind = kinds[kindNumber];
        const before = read[index - 1];
        if (kind === undefined) {
            throw new Error(`token ${index} has the unknown kind ${kindNumber}`);
        }
        if (before && start < before.start + before.length) {
            throw new Error(`token ${index} starts at ${start} before the end of token ${index - 1}`);
        }
        if (start < 0 || length < 0 || start + length > text.length) {
            throw new Error(`token ${index} covers ${start} to ${start + length} outside a text of ${text.length}`);
        }
        if (text.slice(start, start + length).includes('\n')) {
            throw new Error(`token ${index} crosses the line end at ${text.indexOf('\n', start)}`);
        }
        if (targetIndex < -1 || targetIndex >= targets.length) {
            throw new Error(`token ${index} has the target ${targetIndex} of ${targets.length} targets`);
        }

        const target = targetIndex < 0 ? null : targets[targetIndex];
        const parsed = target === null ? undefined : parseTokenTarget(target, index);
        if (parsed && 'local' in parsed && parsed.local >= locals.length) {
            throw new Error(`token ${index} has the local ${parsed.local} of ${locals.length} locals`);
        }

        read.push({ start, length, kind, flags, target });
    }

    return read;
}

export function formatTarget(target: Target): string {
    if ('fileId' in target) {
        return `${target.fileId}:${(target.key >>> 0).toString(16)}`;
    }

    return 'local' in target ? `L:${target.local}` : `|${target.outside}`;
}

export function parseTarget(target: string): Target {
    const [, fileId, key] = /^(\d+):([0-9a-f]{1,8})$/.exec(target) ?? [];
    const [, local] = /^L:(\d+)$/.exec(target) ?? [];
    if (fileId !== undefined && key !== undefined) {
        return { fileId: Number(fileId), key: parseInt(key, 16) | 0 };
    }
    if (local !== undefined) {
        return { local: Number(local) };
    }
    if (target.startsWith('|')) {
        return { outside: target.slice(1) };
    }

    throw new Error(`'${target}' isn't a target`);
}
