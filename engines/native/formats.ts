import { toHex } from '../shared/magic';
import { hasCliHeader, isPeFile } from '../shared/pe';
import type { NativeModule } from './module';

const elfClasses = [1, 2];
const elfByteOrders = [1, 2];
const thinMachoMagics = ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe'];
// the magic of a fat Mach-O file, the only form of it that Rizin reads: big-endian with 32-bit offsets and sizes
const fatMachoMagic = 'cafebabe';
// a class file has its major version, 45 or more, where a fat Mach-O file has its count of slices
const maxFatSlices = 44;
const fatHeaderSize = 8;
const fatEntrySize = 20;

function claimsElf(start: Uint8Array): boolean {
    return start.length >= 6 && elfClasses.includes(start[4]) && elfByteOrders.includes(start[5]);
}

// checks the count of slices and that the first slice lies inside the file, which only reads the first slice's entry
async function claimsFatMacho(file: Blob): Promise<boolean> {
    const header = new DataView((await file.slice(0, fatHeaderSize + fatEntrySize).bytes()).buffer);
    if (header.byteLength < fatHeaderSize + fatEntrySize) {
        return false;
    }

    const count = header.getUint32(4);
    if (count < 1 || count > maxFatSlices) {
        return false;
    }

    const offset = header.getUint32(fatHeaderSize + 8);
    const size = header.getUint32(fatHeaderSize + 12);

    return size > 0 && offset + size <= file.size;
}

/**
 * Checks whether the native engine reads a file from its headers alone: an ELF file of a known class and byte order, a
 * PE file without a CLI header, which the .NET engine reads, and a thin or fat Mach-O file.
 */
export async function claimsNativeFile(file: Blob): Promise<boolean> {
    const start = await file.slice(0, 8).bytes();
    const magic = toHex(start.subarray(0, 4));
    if (magic === '7f454c46') {
        return claimsElf(start);
    }
    if (magic.startsWith('4d5a')) {
        return (await isPeFile(file)) && !(await hasCliHeader(file));
    }
    if (thinMachoMagics.includes(magic)) {
        return true;
    }

    return magic === fatMachoMagic && claimsFatMacho(file);
}

// checks whether a binary only imports from mscoree.dll, like a .NET assembly without its CLI header
function isManagedStub(module: NativeModule, session: number): boolean {
    const imports: { libname?: string }[] = JSON.parse(module.runCommand(session, 'iij') || '[]');

    return imports.length > 0 && imports.every(({ libname }) => /^mscoree\.dll$/i.test(libname ?? ''));
}

/** Returns why the engine can't read the binary of a session's open file, or `undefined` for a binary that it reads. */
export function findRefusal(module: NativeModule, session: number, path: string, name: string): string | undefined {
    if (!module.openSession(session, path)) {
        return `${name} isn't a readable ELF, PE or Mach-O file.`;
    }
    if (isManagedStub(module, session)) {
        return `${name} only imports mscoree.dll, so its code is .NET IL and not machine code.`;
    }

    return undefined;
}
