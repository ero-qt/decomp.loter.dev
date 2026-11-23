import type { StringUse } from '../../contract/engine';
import { cutMark, maxStringLength, maxStrings } from '../../contract/limits';

export { cutMark, maxStringLength, maxStrings } from '../../contract/limits';

/**
 * Cuts a string longer than `maxStringLength` to that length with the cut mark as its last character, before a
 * surrogate pair that the cut would split.
 */
export function cutString(text: string): string {
    if (text.length <= maxStringLength) {
        return text;
    }

    const end = maxStringLength - cutMark.length;
    const splitsPair = /[\ud800-\udbff]/.test(text[end - 1]);

    return `${text.slice(0, splitsPair ? end - 1 : end)}${cutMark}`;
}

/** Keeps the first `maxStrings` strings and cuts each with `cutString`. */
export function capStrings(strings: StringUse[]): StringUse[] {
    return strings.slice(0, maxStrings).map(({ text, user }) => ({ text: cutString(text), user }));
}
