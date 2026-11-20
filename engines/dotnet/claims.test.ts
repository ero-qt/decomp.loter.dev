import { expect, test } from 'bun:test';
import { peFile, readFixture, useDotnetEngine } from './testing';

const connect = useDotnetEngine();

test('dotnet engine claims a PE file with a CLI header under any name and no native PE file', async () => {
    const engine = connect();
    const drawing = await readFixture('Drawing.dll');
    const native = new File([peFile({ hasCliHeader: false })], 'tool.exe');

    expect(await engine.claims('data.bin', new File([drawing], 'data.bin'))).toBe(true);
    expect(await engine.claims(native.name, native)).toBe(false);
});

test('dotnet engine claims PE files with 32-bit and 64-bit headers', async () => {
    const engine = connect();
    const pe32 = new File([peFile({ is64Bit: false })], 'app32.dll');
    const pe64 = new File([peFile({ is64Bit: true })], 'app64.dll');

    expect(await engine.claims(pe32.name, pe32)).toBe(true);
    expect(await engine.claims(pe64.name, pe64)).toBe(true);
});

test("dotnet engine doesn't claim a truncated PE file, a header offset past the end or a text file named like an assembly", async () => {
    const engine = connect();
    const bytes = peFile({});
    const truncated = new File([bytes.subarray(0, 0x90)], 'cut.dll');
    const pastEnd = bytes.slice(0, 0x40);
    new DataView(pastEnd.buffer).setUint32(0x3c, 0x1000, true);
    const text = new File(['some notes'], 'notes.dll');

    expect(await engine.claims(truncated.name, truncated)).toBe(false);
    expect(await engine.claims('far.dll', new File([pastEnd], 'far.dll'))).toBe(false);
    expect(await engine.claims(text.name, text)).toBe(false);
});
