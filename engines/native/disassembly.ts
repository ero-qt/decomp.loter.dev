import { type Document, formatTarget, type Token, writeTokens } from '../../contract/document';
import { failed, ok, type Reply } from '../../contract/reply';
import { flagsOf, type Kind } from '../../contract/symbols';
import { createYielder } from '../shared/yielding';
import type { CodeRows } from './code';
import type { NativeModule } from './module';
import { readArchitecture } from './sleigh';

/** The rows of the function's file, which a call or jump points at, with each row's full name. */
export interface DisassemblyRows extends CodeRows {
    /** Returns the key, kind and full name, like `geometry::Rect::area`, of the row at an address. */
    findRow(address: bigint): { key: number; kind: Kind; name?: string } | undefined;
}

/** A block of a function as `afbj` lists it. */
interface Block {
    addr: bigint;
    size: number;
}

/** An instruction with a text that uses the names of symbols and with the raw text. */
interface Instruction {
    offset: bigint;
    size: number;
    disasm: string;
    opcode: string;
    jump?: bigint;
}

// the largest part of a function that the engine disassembles, because 256 KB already take about 5 s with the analysis
const maxFunctionBytes = 256 * 1024;
// the bytes that 1 call of the glue disassembles before the engine yields, because the glue takes about 100 ms for
// 8 KB and a cancel then gets through well inside the native engine's cancel limit of 2 s
const chunkBytes = 8 * 1024;
// the architectures that the module's disassembler reads, which only has Rizin's x86 and ARM plugins
const disassembledArchitectures = ['x86', 'arm'];
const declaration = flagsOf('', 'declaration');

/** Returns a refusal for a session's file whose architecture the module's disassembler doesn't read. */
export function checkArchitecture(module: NativeModule, session: number): Reply<undefined> {
    const { arch, name } = readArchitecture(module, session);

    return disassembledArchitectures.includes(arch) ? ok(undefined) : failed(`The native engine can't disassemble ${name} code.`);
}

// reads the blocks that `afbj` lists with their addresses as big integers, because a JavaScript number loses the low
// bits of an address above 2^53
function readBlocks(text: string): Block[] {
    const quoted = text.replace(/"addr":(\d+)/g, '"addr":"$1"');

    return JSON.parse(quoted || 'null', (key, value) => (key === 'addr' ? BigInt(value) : value)) ?? [];
}

/**
 * Lists the instructions of a function's blocks in address order until the instructions would pass `maxBytes`.
 * Disassembles each block in chunks and gives the worker's message loop a turn between chunks.
 */
async function listInstructions(
    module: NativeModule,
    session: number,
    address: bigint,
    maxBytes: number,
    signal: AbortSignal,
): Promise<Instruction[]> {
    const yieldTurn = createYielder(signal);
    const blocks = readBlocks(module.runCommand(session, `afbj @ 0x${address.toString(16)}`));
    blocks.sort((first, second) => (first.addr < second.addr ? -1 : first.addr > second.addr ? 1 : 0));

    const instructions: Instruction[] = [];
    let bytes = 0;
    for (const block of blocks) {
        const end = block.addr + BigInt(block.size);
        for (let at = block.addr; at < end; ) {
            await yieldTurn();

            const whole = module.disassemble(session, at, Number(end - at), chunkBytes).map(({ addr, size, text, opcode, jump }) => {
                return { offset: BigInt(addr), size, disasm: text, opcode, jump: jump === undefined ? undefined : BigInt(jump) };
            });
            if (whole.length === 0) {
                break;
            }

            for (const instruction of whole) {
                if (bytes + instruction.size > maxBytes) {
                    return instructions;
                }

                bytes += instruction.size;
                instructions.push(instruction);
            }

            const last = whole.at(-1)!;
            at = last.offset + BigInt(last.size);
        }
    }

    return instructions;
}

// writes the signature as a comment line, whose name declares the function's row when the signature has the name
function writeHeader(signature: string, name: string, rows: DisassemblyRows): { line: string; tokens: Token[] } {
    const prototype = signature.replace(/;$/, '');
    const parameters = prototype.indexOf('(');
    // finds the name before the parameters, because the return type can have the same word
    const start = parameters < 0 ? -1 : prototype.lastIndexOf(name, parameters - name.length);
    const line = start < 0 ? `; ${name}` : `; ${prototype}`;
    const row = rows.findRow(rows.address);
    if (!row) {
        return { line, tokens: [] };
    }

    const target = formatTarget({ fileId: rows.fileId, key: row.key });

    return { line, tokens: [{ start: '; '.length + Math.max(0, start), length: name.length, kind: row.kind, flags: declaration, target }] };
}

/**
 * Writes an instruction's text, where a call or jump to a function with a row shows the function's full name. A jump
 * to another place inside the function shows the label of its target. Returns where the name starts in the text.
 */
function writeInstruction(
    { disasm, opcode, jump }: Instruction,
    shown: Set<bigint>,
    rows: DisassemblyRows,
): { text: string; name?: { at: number; length: number; kind: Kind; target?: string; label?: bigint } } {
    const jumpText = jump === undefined ? '' : `0x${jump.toString(16)}`;
    const at = jump === undefined ? -1 : opcode.indexOf(jumpText);
    if (jump === undefined || at < 0) {
        return { text: disasm };
    }

    const replace = (name: string) => opcode.slice(0, at) + name + opcode.slice(at + jumpText.length);
    const row = rows.findRow(jump);
    if (row?.name !== undefined) {
        const target = formatTarget({ fileId: rows.fileId, key: row.key });

        return { text: replace(row.name), name: { at, length: row.name.length, kind: row.kind, target } };
    }
    if (!shown.has(jump)) {
        return { text: disasm };
    }

    const label = `loc_${jump.toString(16)}`;

    return { text: replace(label), name: { at, length: label.length, kind: 'label', label: jump } };
}

/**
 * Disassembles the blocks of the function at the address of `rows` in address order, each instruction after its
 * address, below the function's signature. A call or jump to another function points at its row. A jump inside the
 * function points at a label, which the address of its target's line declares. Stops before the instruction that
 * would pass `maxBytes` and adds a note with the function's size. Throws once the signal aborts, between 2 chunks of
 * code. Refuses an address without a function.
 */
export async function disassembleFunction(
    module: NativeModule,
    session: number,
    rows: DisassemblyRows,
    signal: AbortSignal,
    maxBytes = maxFunctionBytes,
): Promise<Reply<Document>> {
    const prepared = module.prepareFunction(session, rows.address);
    if (!prepared) {
        return failed(`Rizin doesn't find a function at 0x${rows.address.toString(16)}.`);
    }

    const instructions = await listInstructions(module, session, rows.address, maxBytes, signal);
    const shown = new Set(instructions.map(({ offset }) => offset));
    const header = writeHeader(prepared.signature, prepared.name, rows);
    const written = instructions.map(instruction => writeInstruction(instruction, shown, rows));

    // loops because a spread of a long function's addresses passes the engine's limit of arguments
    let width = 8;
    for (const { offset } of instructions) {
        width = Math.max(width, offset.toString(16).length);
    }
    // address of a shown instruction -> the start of its line in the text
    const lineStarts = new Map<bigint, number>();
    const lines = [header.line];
    let lineStart = header.line.length + 1;
    for (const [index, { offset }] of instructions.entries()) {
        const line = `${offset.toString(16).padStart(width, '0')}  ${written[index].text}`;
        lineStarts.set(offset, lineStart);
        lines.push(line);
        lineStart += line.length + 1;
    }

    const tokens = header.tokens;
    const locals: string[] = [];
    // address of a jump's target -> the target of its label
    const labels = new Map<bigint, string>();
    for (const [index, { offset }] of instructions.entries()) {
        const { name } = written[index];
        if (!name) {
            continue;
        }

        const start = lineStarts.get(offset)! + width + 2 + name.at;
        const { label: address } = name;
        if (address === undefined) {
            tokens.push({ start, length: name.length, kind: name.kind, flags: 0, target: name.target ?? null });
            continue;
        }

        const label = labels.get(address) ?? labels.set(address, `L:${locals.push(`loc_${address.toString(16)}`) - 1}`).get(address)!;
        tokens.push({ start, length: name.length, kind: 'label', flags: 0, target: label });
    }

    for (const [address, label] of labels) {
        tokens.push({ start: lineStarts.get(address)!, length: width, kind: 'label', flags: declaration, target: label });
    }

    const shownBytes = instructions.reduce((sum, { size }) => sum + size, 0);
    if (shownBytes < prepared.size) {
        lines.push(`; ${prepared.size.toLocaleString('en')} bytes of code, of which the engine shows the first ${shownBytes.toLocaleString('en')}.`);
    }

    tokens.sort((first, second) => first.start - second.start);

    return ok(writeTokens(`${lines.join('\n')}\n`, tokens, locals));
}
