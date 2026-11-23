import { expect, test } from 'bun:test';
import { capStrings, cutString, maxStringLength, maxStrings } from './limits';

test('cutString keeps a string of up to 1,000 characters whole', () => {
    expect(cutString('x'.repeat(maxStringLength))).toBe('x'.repeat(maxStringLength));
});

test('cutString cuts a longer string to 1,000 characters with the mark as its last character', () => {
    expect(cutString('x'.repeat(1001))).toBe(`${'x'.repeat(999)}…`);
});

test('cutString cuts before a surrogate pair that the cut would split', () => {
    expect(cutString(`${'x'.repeat(998)}😀${'x'.repeat(10)}`)).toBe(`${'x'.repeat(998)}…`);
});

test('capStrings keeps the first strings up to the limit and cuts each', () => {
    const strings = Array.from({ length: maxStrings + 1 }, (_, index) => ({ text: index === 0 ? 'y'.repeat(2000) : 'x', user: null }));
    const capped = capStrings(strings);

    expect(capped).toHaveLength(maxStrings);
    expect(capped[0]).toEqual({ text: `${'y'.repeat(999)}…`, user: null });
});
