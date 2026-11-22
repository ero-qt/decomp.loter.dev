import { expect, test } from 'bun:test';
import { isPeFile } from './pe';

// writes a 64-byte DOS header whose header offset points at a PE signature and an empty COFF header right after it
function peHeaders(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(64 + 4 + 20 + 2);
    bytes.set([0x4d, 0x5a]);
    new DataView(bytes.buffer).setUint32(0x3c, 64, true);
    bytes.set([0x50, 0x45, 0, 0], 64);

    return bytes;
}

test('isPeFile reads a 64-byte DOS header and the PE signature that its header offset points at', async () => {
    expect(await isPeFile(new Blob([peHeaders()]))).toBe(true);
});

test("isPeFile doesn't take a DOS header shorter than 64 bytes", async () => {
    expect(await isPeFile(new Blob([peHeaders().subarray(0, 63)]))).toBe(false);
});
