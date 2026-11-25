import { failed, ok, type Reply } from '#contract/reply';
import type { NativeModule } from './module';

// Rizin's name of an architecture -> the name that a refusal gives it
const architectureNames: Record<string, string> = { mips: 'MIPS', ppc: 'PowerPC', riscv: 'RISC-V', sparc: 'SPARC' };

/** The architecture of a session's file from its headers, with the name that a refusal gives it, like `MIPS`. */
export interface Architecture {
    arch: string;
    bits: number;
    name: string;
}

/**
 * Reads the architecture of a session's file from its headers, because Rizin's disassembler falls back to another
 * one without a plugin for the file's.
 */
export function readArchitecture(module: NativeModule, session: number): Architecture {
    const { arch = '', bits = 0 }: { arch?: string; bits?: number } = JSON.parse(module.runCommand(session, 'iIj') || '{}');

    return { arch, bits, name: arch === 'arm' ? `${bits}-bit ARM` : (architectureNames[arch] ?? arch) };
}

/**
 * Returns the Ghidra processor of a session's file, like `x86` or `AARCH64`, whose languages the decompiler reads, or
 * a refusal for an architecture whose languages the module doesn't have, like 32-bit ARM.
 */
export function findProcessor(module: NativeModule, session: number): Reply<string> {
    const { arch, bits, name } = readArchitecture(module, session);
    if (arch === 'x86') {
        return ok('x86');
    }
    if (arch === 'arm' && bits === 64) {
        return ok('AARCH64');
    }

    return failed(`The native engine can't decompile ${name} code.`);
}

/**
 * Returns the function that writes a processor's compiled languages into the module's file system before its first
 * decompile. Writes the small specification files of every processor with the first call, even without a processor,
 * because Ghidra reads them all to list its languages. Shares a pending write with later calls and forgets a failed
 * one, so a failed fetch tries again with the next call.
 */
export function createLanguageWriter(module: NativeModule): (processor?: string) => Promise<void> {
    let listing: Promise<string[]> | undefined;
    // processor -> the write of the processor's languages
    const writes = new Map<string, Promise<void>>();

    // writes files listed as `processor/file`, because Ghidra finds a file in its processor's folder
    async function writeFiles(files: string[]) {
        const contents = await Promise.all(files.map(file => module.fetchFile(`sleigh/${file}`)));
        files.forEach((file, index) => {
            const [processor, name] = file.split('/');
            const folder = `/sleigh/Ghidra/Processors/${processor}/data/languages`;
            module.fs.mkdirTree(folder);
            module.fs.writeFile(`${folder}/${name}`, contents[index]);
        });
    }

    async function listFiles(): Promise<string[]> {
        const files = new TextDecoder().decode(await module.fetchFile('sleigh/files.txt')).split('\n').filter(Boolean);
        await writeFiles(files.filter(file => !file.endsWith('.sla')));

        return files;
    }

    // forgets a failed listing, so the next call fetches the list again
    function useListing(): Promise<string[]> {
        listing ??= listFiles().catch(error => {
            listing = undefined;
            throw error;
        });

        return listing;
    }

    function useWrite(processor: string, files: string[]): Promise<void> {
        let write = writes.get(processor);
        if (!write) {
            write = writeFiles(files.filter(file => file.startsWith(`${processor}/`) && file.endsWith('.sla'))).catch(error => {
                writes.delete(processor);
                throw error;
            });
            writes.set(processor, write);
        }

        return write;
    }

    return async processor => {
        const files = await useListing();
        if (processor !== undefined) {
            await useWrite(processor, files);
        }
    };
}
