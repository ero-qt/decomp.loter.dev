/** The most strings that an engine lists for a file, because the worker sends every string to the page. */
export const maxStrings = 50000;

/**
 * The most UTF-16 units of a string that an engine lists, because quick open shows a string on 1 line. An engine cuts a
 * longer string to this length with the cut mark as its last character.
 */
export const maxStringLength = 1000;

/** The mark at the end of a string that an engine cut at `maxStringLength`. */
export const cutMark = '…';
