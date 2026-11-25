import { formatTarget } from '#contract/document';
import type { StringUse } from '#contract/engine';
import { cutString, maxStringLength, maxStrings } from '../shared/limits';
import type { NativeModule } from './module';
import { type FindFunction, findUsers } from './users';

// reads at most 4 bytes of UTF-8 for each character that the engine keeps
const maxStringBytes = maxStringLength * 4;
// the strings whose users the engine finds between 2 checks of the signal
const stringsPerYield = 1000;

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
        uses.push({ text: cutString(text), user: user === undefined ? null : formatTarget({ fileId, key: user }) });
    }

    return uses;
}
