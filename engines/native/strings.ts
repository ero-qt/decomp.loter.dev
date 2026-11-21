import { formatTarget } from '../../contract/document';
import type { StringUse } from '../../contract/engine';
import type { NativeModule } from './module';
import { type FindFunction, findUsers } from './users';

/**
 * The most strings that the engine lists, about 10 times the 4,912 that the code of OpenSSL 3.5's libcrypto.so uses,
 * because each string's users take a search of their own.
 */
export const maxStrings = 50000;
// cuts a string after 1,000 characters like the .NET engine, because quick open shows a string on 1 line
const maxStringLength = 1000;
// reads at most 4 bytes of UTF-8 for each character that the engine keeps
const maxStringBytes = maxStringLength * 4;
// the strings whose users the engine finds between 2 checks of the signal
const stringsPerYield = 1000;

// cuts a long string after the length with a mark, before a surrogate pair that the cut would split
function cutText(text: string): string {
    if (text.length <= maxStringLength) {
        return text;
    }

    const splitsPair = /[\ud800-\udbff]/.test(text[maxStringLength - 1]);

    return `${text.slice(0, splitsPair ? maxStringLength - 1 : maxStringLength)}…`;
}

/**
 * Lists the first strings of a session's file, each with the row target of the first function whose code uses it.
 * Yields to other tasks between parts of the strings, and throws once the signal aborts.
 */
export async function listStrings(
    module: NativeModule,
    session: number,
    fileId: number,
    findFunction: FindFunction,
    signal: AbortSignal,
): Promise<StringUse[]> {
    const strings = module.listStrings(session, maxStrings, maxStringBytes);
    const uses: StringUse[] = [];

    for (const [index, { addr, text }] of strings.entries()) {
        if (index % stringsPerYield === 0) {
            await new Promise(resolve => setTimeout(resolve));
            signal.throwIfAborted();
        }

        const [user] = findUsers(module, session, findFunction, BigInt(addr));
        uses.push({ text: cutText(text), user: user === undefined ? null : formatTarget({ fileId, key: user }) });
    }

    return uses;
}
