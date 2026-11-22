import { type Document, type Token, writeTokens } from '../../contract/document';

/** How a language writes its comments and strings, which `findWords` skips, and the pattern of a word. */
export interface WordSyntax {
    lineComment: string;
    /** The start and the end of a comment that can go over lines. */
    blockComment?: [start: string, end: string];
    /** The marks that start and end a string, where a backslash escapes the next character. */
    quotes: string[];
    /** Whether the language has Lua's long brackets, like `[[text]]` and `--[==[comment]==]`. */
    longBrackets?: boolean;
    /** The pattern of a word, like `[A-Za-z_]\w*` for a name in C. */
    identifier: RegExp;
}

/** A word in a text, with its start and length in UTF-16 code units and the index of its line. */
export interface Word {
    start: number;
    length: number;
    text: string;
    line: number;
}

const longBracket = /\[(=*)\[/y;

// returns the end of the string that starts at the quote, after its closing quote or at the line's end
function skipString(text: string, start: number, quote: string): number {
    let index = start + quote.length;
    while (index < text.length && text[index] !== '\n' && !text.startsWith(quote, index)) {
        index += text[index] === '\\' ? 2 : 1;
    }

    return Math.min(text.startsWith(quote, index) ? index + quote.length : index, text.length);
}

// returns the end of a long bracket's text at the start, or `undefined` when a long bracket doesn't start there
function skipLongBracket(text: string, start: number): number | undefined {
    longBracket.lastIndex = start;
    const match = longBracket.exec(text);
    if (!match) {
        return undefined;
    }

    const end = text.indexOf(`]${match[1]}]`, start + match[0].length);

    return end < 0 ? text.length : end + match[0].length;
}

// returns the end of the comment or string that starts at the index, or `undefined` when neither starts there
function skipComment(text: string, index: number, { lineComment, blockComment, quotes, longBrackets }: WordSyntax): number | undefined {
    if (text.startsWith(lineComment, index)) {
        const longEnd = longBrackets ? skipLongBracket(text, index + lineComment.length) : undefined;
        const lineEnd = text.indexOf('\n', index);

        return longEnd ?? (lineEnd < 0 ? text.length : lineEnd);
    }
    if (blockComment && text.startsWith(blockComment[0], index)) {
        const end = text.indexOf(blockComment[1], index + blockComment[0].length);

        return end < 0 ? text.length : end + blockComment[1].length;
    }

    const quote = quotes.find(mark => text.startsWith(mark, index));
    if (quote !== undefined) {
        return skipString(text, index, quote);
    }

    return longBrackets ? skipLongBracket(text, index) : undefined;
}

/**
 * Finds the words in a text and skips its comments and strings. A word only starts after a character that can't be in
 * a word, so a number like `0x1F` doesn't give a word.
 */
export function findWords(text: string, syntax: WordSyntax): Word[] {
    const identifier = new RegExp(syntax.identifier.source, 'y');
    const words: Word[] = [];
    let line = 0;
    let index = 0;

    while (index < text.length) {
        const skipped = skipComment(text, index, syntax);
        if (skipped !== undefined) {
            line += text.slice(index, skipped).split('\n').length - 1;
            index = skipped;
            continue;
        }

        identifier.lastIndex = index;
        const match = index > 0 && /[\w$]/.test(text[index - 1]) ? null : identifier.exec(text);
        if (match) {
            words.push({ start: index, length: match[0].length, text: match[0], line });
            index += match[0].length;
            continue;
        }

        line += text[index] === '\n' ? 1 : 0;
        index++;
    }

    return words;
}

/** Writes a document with a token for each word that `pick` turns into a token. */
export function writeWordTokens(
    text: string,
    words: Word[],
    pick: (word: Word) => Omit<Token, 'start' | 'length'> | undefined,
    locals: string[],
): Document {
    const tokens = words.flatMap(word => {
        const picked = pick(word);

        return picked ? [{ ...picked, start: word.start, length: word.length }] : [];
    });

    return writeTokens(text, tokens, locals);
}
