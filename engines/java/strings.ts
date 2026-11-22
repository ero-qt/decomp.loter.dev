import { formatTarget } from '../../contract/document';
import type { StringUse } from '../../contract/engine';
import { cutString, maxStrings } from '../shared/limits';
import { createYielder } from '../shared/yielding';
import { readClass, readStrings } from './classfile';
import type { OpenFile } from './handlers';

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
 * what the tree needs, and doesn't keep the listing because the page keeps it. Gives the worker's message loop a turn
 * between classes and throws once the signal aborts.
 */
export async function listStrings(fileId: number, file: OpenFile, signal: AbortSignal): Promise<StringUse[]> {
    const yieldTurn = createYielder(signal);
    const strings: StringUse[] = [];

    for (const [name, { entry }] of file.classes) {
        await yieldTurn();

        const bytes = await file.zip.read(entry);
        const shown = findShownClass(file, name);
        for (const { text, key } of bytes ? readStrings(readClass(bytes), name) : []) {
            const row = file.keys.get(key) ?? shown;
            strings.push({ text: cutString(text), user: row === undefined ? null : formatTarget({ fileId, key: row }) });
            if (strings.length === maxStrings) {
                return strings;
            }
        }
    }

    return strings;
}
