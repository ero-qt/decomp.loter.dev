import { type Document, writeTokens } from '#contract/document';
import { ok, type Reply } from '#contract/reply';
import { decompileAt } from './code';
import { maxImageSpan } from './keys';
import type { NativeModule } from './module';

/** A section of a file's image by its offsets from the image base, with whether it has code. */
export interface Section {
    name: string;
    start: number;
    end: number;
    isCode: boolean;
}

// the bytes of a global's data that its document shows
const dataBytes = 64;

/** Lists the sections of a file's image that fit into the image's span from its base. */
export function listSections(module: NativeModule, session: number, base: bigint): Section[] {
    const sections: { name?: string; vaddr?: number; vsize?: number; perm?: string }[] = JSON.parse(module.runCommand(session, 'iSj') || '[]');

    return sections.flatMap(({ name = '', vaddr = 0, vsize = 0, perm = '' }) => {
        const start = BigInt(vaddr) - base;
        const isInImage = vsize > 0 && start >= 0n && start + BigInt(vsize) <= maxImageSpan;

        return isInImage ? [{ name, start: Number(start), end: Number(start) + vsize, isCode: perm.includes('x') }] : [];
    });
}

/** Finds the section with an offset from the image base, or `undefined` for an offset outside the sections. */
export function findSection(sections: Section[], rva: number): Section | undefined {
    return rva < 0 ? undefined : sections.find(section => rva >= section.start && rva < section.end);
}

/**
 * Reads the C of the code at an offset from the image base that the file's rows don't have, like a function that only
 * a call names, or a comment with the bytes of a global's data, because Ghidra only decompiles code.
 */
export function readAddress(module: NativeModule, session: number, fileId: number, base: bigint, rva: number, section: Section): Reply<Document> {
    if (section.isCode) {
        return decompileAt(module, session, fileId, base, rva);
    }

    const address = `0x${(base + BigInt(rva)).toString(16)}`;
    const bytes = module.runCommand(session, `px ${dataBytes} @ ${address}`).trimEnd();
    const text = `// ${address} in ${section.name} holds data, not code.\n\n${bytes.replace(/^/gm, '// ')}\n`;

    return ok(writeTokens(text, [], []));
}
