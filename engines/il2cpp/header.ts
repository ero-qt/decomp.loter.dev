// the metadata versions that LibCpp2IL has layouts for, from Unity 5.6's version 23 to version 106
const readableVersions = { oldest: 23, newest: 106 };

// the versions that Unity writes with room on both sides, because a header with a version outside of them is
// scrambled and not just new or old
const plausibleVersions = { oldest: 16, newest: 200 };
// the sections from the string literals to the type definitions, which every version has first and in this order
const leadingSections = 20;
const namesSection = 2;
// the share of the string section that may fail to read as UTF-8, because the section also keeps each assembly's
// public key as raw bytes
const maxBinaryShare = 0.01;

interface Section {
    offset: number;
    size: number;
}

// reads the leading sections' offsets and sizes, which take 12 bytes each with a count since version 38
function readSections(view: DataView, version: number): Section[] | undefined {
    const sectionBytes = version >= 38 ? 12 : 8;
    if (view.byteLength < 8 + leadingSections * sectionBytes) {
        return undefined;
    }

    return Array.from({ length: leadingSections }, (_, index) => {
        const start = 8 + index * sectionBytes;

        return { offset: view.getInt32(start, true), size: view.getInt32(start + 4, true) };
    });
}

function isInside({ offset, size }: Section, fileBytes: number): boolean {
    return offset >= 0 && size >= 0 && offset + size <= fileBytes;
}

function isMostlyText(bytes: Uint8Array): boolean {
    const replacedCount = new TextDecoder().decode(bytes).match(/\uFFFD/g)?.length ?? 0;

    return replacedCount <= bytes.length * maxBinaryShare;
}

/**
 * Checks that the bytes start like a `global-metadata.dat` file that LibCpp2IL reads, with a version that it reads,
 * leading sections inside the file and a string section of mostly UTF-8 text, because encrypted metadata often keeps
 * the magic. Returns the refusal's text, or `undefined` for a file that passes.
 */
export function checkMetadata(name: string, bytes: Uint8Array): string | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const damaged = `${name} is encrypted or damaged.`;
    const version = bytes.length >= 8 ? view.getInt32(4, true) : 0;
    if (version < plausibleVersions.oldest || version > plausibleVersions.newest) {
        return damaged;
    }
    if (version < readableVersions.oldest || version > readableVersions.newest) {
        return `${name} has version ${version}, which the engine can't read.`;
    }

    const sections = readSections(view, version);
    if (!sections?.every(section => isInside(section, bytes.length))) {
        return damaged;
    }

    const names = sections[namesSection];

    return isMostlyText(bytes.subarray(names.offset, names.offset + names.size)) ? undefined : damaged;
}
