/**
 * Returns a function that finds the line and character of an offset in the text, with an offset past the text's end at
 * the end. Lists the lines' starts once and finds each offset's line by binary search, because a document can have
 * thousands of tokens to locate.
 */
export function createPositionFinder(text: string): (offset: number) => { line: number; character: number } {
    // counts the lines by `\n` because a document's text ends each line with `\n`
    const lineStarts = [0];
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
        lineStarts.push(index + 1);
    }

    return offset => {
        const clamped = Math.min(offset, text.length);
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (lineStarts[middle] <= clamped) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }

        return { line: low, character: clamped - lineStarts[low] };
    };
}
