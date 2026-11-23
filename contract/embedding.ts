import { type Document, parseTarget, readTokens, type Token } from './document';

/**
 * Lines of another document that a document shows inside its own text, like the body of a C function inside a C#
 * method, with their tokens from the start of the lines and the declarations of their local symbols.
 */
export interface EmbeddedLines {
    text: string;
    tokens: Token[];
    locals: string[];
}

/**
 * Takes the lines between the first line `{` and the last line `}` of a document, like a C function's body, with the
 * tokens on them, or returns `undefined` for a document without such lines.
 */
export function sliceBody(document: Document): EmbeddedLines | undefined {
    const lines = document.text.split('\n');
    const open = lines.indexOf('{');
    const close = lines.lastIndexOf('}');
    if (open < 0 || close <= open) {
        return undefined;
    }

    const start = lines.slice(0, open + 1).join('\n').length + 1;
    const end = start + lines.slice(open + 1, close).join('\n').length;
    const tokens = readTokens(document)
        .filter(token => token.start >= start && token.start + token.length <= end)
        .map(token => ({ ...token, start: token.start - start }));

    return { text: document.text.slice(start, end), tokens, locals: document.locals };
}

/**
 * Puts `indent` before each line that isn't empty and drops the spaces at each line's end, with the tokens moved
 * along.
 */
export function indentLines({ text, tokens, locals }: EmbeddedLines, indent: string): EmbeddedLines {
    const lines = text.split('\n');
    // each line's start in the text and in the indented text
    const starts: [from: number, to: number][] = [];
    let from = 0;
    let to = 0;
    const indented = lines.map(line => {
        const written = line.trimEnd() === '' ? '' : `${indent}${line.trimEnd()}`;
        starts.push([from, to + (written === '' ? 0 : indent.length)]);
        from += line.length + 1;
        to += written.length + 1;

        return written;
    });

    return { text: indented.join('\n'), tokens: moveByLines(tokens, starts), locals };
}

/**
 * Moves tokens along with their lines, from each line's start in the old text to its start in the new text, with the
 * lines in order.
 */
export function moveByLines(tokens: Token[], starts: [from: number, to: number][]): Token[] {
    return tokens.map(token => {
        let low = 0;
        let high = starts.length - 1;
        while (low < high) {
            const middle = (low + high + 1) >>> 1;
            if (starts[middle][0] <= token.start) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }

        const [lineFrom, lineTo] = starts[low] ?? [0, 0];

        return { ...token, start: token.start - lineFrom + lineTo };
    });
}

/**
 * Moves embedded lines' tokens to `start` in the document that shows them. A local target moves past the document's
 * own `localCount` locals, and each other target becomes the target that `mapTarget` gives, or none.
 */
export function placeTokens(lines: EmbeddedLines, start: number, localCount: number, mapTarget: (target: string) => string | null): Token[] {
    return lines.tokens.map(token => {
        const parsed = token.target === null ? undefined : parseTarget(token.target);
        let target: string | null = null;
        if (parsed && 'local' in parsed) {
            target = `L:${parsed.local + localCount}`;
        } else if (token.target !== null) {
            target = mapTarget(token.target);
        }

        return { ...token, start: token.start + start, target };
    });
}
