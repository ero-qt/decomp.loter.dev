import { formatTarget } from '../../contract/document';
import type { StringUse } from '../../contract/engine';
import { readClass, readStrings } from './classfile';
import type { OpenFile } from './handlers';

// keeps the listing small like the other engines because a large JAR loads hundreds of thousands of strings
const maxStrings = 50000;
const maxStringLength = 1000;

// cuts a long string after the length with a mark, before a surrogate pair that the cut would split
function cutText(text: string): string {
    if (text.length <= maxStringLength) {
        return text;
    }

    const splitsPair = /[\ud800-\udbff]/.test(text[maxStringLength - 1]);

    return `${text.slice(0, splitsPair ? maxStringLength - 1 : maxStringLength)}…`;
}

// returns the row of the nearest class that the tree shows, starting at the class itself
function findShownClass({ keys, outers }: OpenFile, name: string): number | undefined {
    let current: string | undefined = name;
    while (current !== undefined && !keys.has(current)) {
        current = outers.get(current);
    }

    return current === undefined ? undefined : keys.get(current);
}

/**
 * Lists the strings of an open file's classes with the row of the member that uses each, or the row of the nearest
 * shown class for a member without a row, like a lambda's method. Reads each class again because the file only keeps
 * what the tree needs, and keeps no listing because the page keeps it. Throws once the signal aborts.
 */
export async function listStrings(fileId: number, file: OpenFile, signal: AbortSignal): Promise<StringUse[]> {
    const strings: StringUse[] = [];

    for (const [name, { entry }] of file.classes) {
        signal.throwIfAborted();

        const bytes = await file.zip.read(entry);
        const shown = findShownClass(file, name);
        for (const { text, key } of bytes ? readStrings(readClass(bytes), name) : []) {
            const row = file.keys.get(key) ?? shown;
            strings.push({ text: cutText(text), user: row === undefined ? null : formatTarget({ fileId, key: row }) });
            if (strings.length === maxStrings) {
                return strings;
            }
        }
    }

    return strings;
}
