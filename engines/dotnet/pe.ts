const dosHeaderSize = 64;
const headerOffsetField = 0x3c;
const signatureSize = 4;
const coffHeaderSize = 20;
const optionalHeaderSizeField = 16;
const cliDirectory = 14;
const directorySize = 8;
// the largest optional header that a CLI header can sit in: a 64-bit header with 16 data directories
const maxOptionalHeaderSize = 240;

// the fields of an optional header that differ between PE32 and PE32+
const headerLayouts = new Map([
    [0x10b, { directoryCount: 92, directories: 96 }],
    [0x20b, { directoryCount: 108, directories: 112 }],
]);

function readsAscii(view: DataView, offset: number, text: string): boolean {
    return [...text].every((character, index) => view.getUint8(offset + index) === character.charCodeAt(0));
}

/**
 * Checks whether a file is a PE file with a CLI header, which every .NET assembly has and a native PE file doesn't.
 * Reads the DOS header and then the PE headers, never the whole file.
 */
export async function hasCliHeader(file: Blob): Promise<boolean> {
    const dos = new DataView((await file.slice(0, dosHeaderSize).bytes()).buffer);
    if (dos.byteLength < dosHeaderSize || !readsAscii(dos, 0, 'MZ')) {
        return false;
    }

    const headerOffset = dos.getUint32(headerOffsetField, true);
    const headerEnd = headerOffset + signatureSize + coffHeaderSize + maxOptionalHeaderSize;
    const headers = new DataView((await file.slice(headerOffset, headerEnd).bytes()).buffer);
    const optional = signatureSize + coffHeaderSize;
    if (headers.byteLength < optional + 2 || !readsAscii(headers, 0, 'PE\0\0')) {
        return false;
    }

    const optionalSize = headers.getUint16(signatureSize + optionalHeaderSizeField, true);
    const layout = headerLayouts.get(headers.getUint16(optional, true));
    if (!layout) {
        return false;
    }

    const directory = layout.directories + cliDirectory * directorySize;
    const readableSize = Math.min(optionalSize, headers.byteLength - optional);
    if (directory + directorySize > readableSize || headers.getUint32(optional + layout.directoryCount, true) <= cliDirectory) {
        return false;
    }

    return headers.getUint32(optional + directory, true) !== 0 && headers.getUint32(optional + directory + 4, true) !== 0;
}
