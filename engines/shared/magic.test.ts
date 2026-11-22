import { expect, test } from 'bun:test';
import { readStartHex, toHex } from './magic';

test('toHex writes 2 lowercase digits for each byte', () => {
    expect(toHex(Uint8Array.of(0, 0x0f, 0xab))).toBe('000fab');
});

test("readStartHex of a file shorter than the count returns the hex of the file's bytes", async () => {
    expect(await readStartHex(new Blob([Uint8Array.of(0xca, 0xfe)]), 4)).toBe('cafe');
});

test('readStartHex reads only the first bytes up to the count', async () => {
    expect(await readStartHex(new Blob([Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 2, 1)]), 4)).toBe('7f454c46');
});
