import { expect, test } from 'bun:test';
import { peFile } from '../dotnet/testing';
import { classFile } from '../java/testing';
import { readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();

// writes a fat Mach-O header with 1 slice of 16 bytes at offset 64, in a file of 80 bytes
function fatHeader(magic: number, isLittleEndian: boolean, is64Bit: boolean): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(80);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, magic);
    view.setUint32(4, 1, isLittleEndian);
    if (is64Bit) {
        view.setBigUint64(16, 64n);
        view.setBigUint64(24, 16n);
    } else {
        view.setUint32(16, 64, isLittleEndian);
        view.setUint32(20, 16, isLittleEndian);
    }

    return bytes;
}

async function claimsAs(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
    return connect().claims(name, new File([bytes], name));
}

test('native engine claims an elf, a native pe and thin and fat mach-o files under any name', async () => {
    const names = ['shapes-x64.so', 'shapes-x86.so', 'shapes.dll', 'shapes-x86.dll', 'shapes-arm64.dylib', 'shapes-fat.dylib'];

    for (const name of names) {
        const bytes = await (await readFixture(name)).bytes();

        expect(await claimsAs('data.bin', bytes)).toBe(true);
    }

    expect(await claimsAs('tool.exe', peFile({ hasCliHeader: false }))).toBe(true);
});

test("native engine doesn't claim a .net assembly, a class file, a truncated header or a fat mach-o file that rizin can't read", async () => {
    const elf = await (await readFixture('shapes-x64.so')).bytes();
    const fat = await (await readFixture('shapes-fat.dylib')).bytes();
    const noSlices = fat.slice(0, 64);
    new DataView(noSlices.buffer).setUint32(4, 0);
    const pastEnd = fat.slice(0, 4096);
    const fat64 = fatHeader(0xcafebabf, false, true);
    const littleEndian = fatHeader(0xbebafeca, true, false);
    const unknownClass = elf.slice(0, 64);
    unknownClass[4] = 3;

    expect(await claimsAs('App.dll', peFile({}))).toBe(false);
    expect(await claimsAs('A.class', classFile({ name: 'a/A' }))).toBe(false);
    expect(await claimsAs('cut.so', elf.slice(0, 5))).toBe(false);
    expect(await claimsAs('odd.so', unknownClass)).toBe(false);
    expect(await claimsAs('cut.exe', peFile({ hasCliHeader: false }).slice(0, 0x82))).toBe(false);
    expect(await claimsAs('empty.dylib', noSlices)).toBe(false);
    expect(await claimsAs('cut.dylib', pastEnd)).toBe(false);
    expect(await claimsAs('fat64.dylib', fat64)).toBe(false);
    expect(await claimsAs('little.dylib', littleEndian)).toBe(false);
});
