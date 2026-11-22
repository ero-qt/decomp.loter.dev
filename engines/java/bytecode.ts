import type { Node } from '@katana-project/asm';
import { disassemble, escapeLiteral } from '@katana-project/asm/analysis/disasm';
import { type Document, formatTarget, type Token, writeTokens } from '../../contract/document';
import { failed, ok, type Reply } from '../../contract/reply';
import { flagsOf } from '../../contract/symbols';
import { createYielder } from '../shared/yielding';
import { readClass } from './classfile';
import { findKeyRow, findMember, type FoundRow, type OpenFiles } from './describe';
import { findTop } from './files';
import type { OpenFile } from './handlers';

// the disassembler starts a class's declaration at the line's start and ends it with ` {`
const classLine = /^(?!\/\/|\s).* \{$/;
// the disassembler indents a field's or method's first line once, after its comments and annotations
const memberLine = /^ {4}[^ /@}]/;
// an instruction line, like `        //  4: invokevirtual java/lang/String trim ()Ljava/lang/String;`
const instructionLine = /^\s*\/\/ *\d+: (\w+) (.+)$/;
// the instructions whose operands are a member, written as `owner name descriptor`
const memberInstructions = /^(invoke(virtual|special|static|interface)|(get|put)(field|static))$/;
// the instructions whose first operand is a class
const classInstructions = ['new', 'checkcast', 'instanceof', 'anewarray', 'multianewarray', 'ldc', 'ldc_w'];
// the lines that the disassembler writes above a class, which a document writes once: the source file, the package
// and the imports, the last 2 each with a blank line after them
const classHead = /^(\/\/ Source file: .*\n)?(package .*;\n\n)?((?:import .*;\n)*)\n?/;
const declaration = flagsOf('', 'declaration');
const documentFlag = flagsOf('', 'document');

function readMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function listLines(text: string): { line: string; start: number }[] {
    let start = 0;

    return text.split('\n').map(line => {
        const found = { line, start };
        start += line.length + 1;

        return found;
    });
}

// finds a field's name before its constant value or its semicolon, like `radius` in `private final double radius;`
function findFieldName(line: string, name: string): { start: number; length: number } {
    const valued = line.indexOf(` ${name} = `);

    return { start: (valued >= 0 ? valued : line.lastIndexOf(` ${name};`)) + 1, length: name.length };
}

// finds a method's name before its parameters, which the disassembler writes as the class's simple name for a
// constructor and as `static` for the static initializer
function findMethodName(line: string, name: string, simpleName: string): { start: number; length: number } {
    if (name === '<clinit>') {
        return { start: line.indexOf('static'), length: 'static'.length };
    }

    const shown = name === '<init>' ? simpleName : escapeLiteral(name);

    return { start: line.indexOf(` ${shown}(`) + 1, length: shown.length };
}

/**
 * Returns the tokens that declare the rows of a class and of its fields and methods in the class's text, which starts
 * at `offset` in the document.
 */
function declareRows(file: OpenFile, fileId: number, internalName: string, node: Node, text: string, offset: number): Token[] {
    const tokens: Token[] = [];
    const lines = listLines(text);

    function addRow(key: string, start: number, length: number) {
        const index = file.keys.get(key);
        if (index === undefined || file.rowKeys[index] !== key) {
            return;
        }

        const { kind, flags, key: rowKey } = file.rows[index];
        const target = formatTarget({ fileId, key: rowKey });
        tokens.push({ start: offset + start, length, kind, flags: (flags & ~documentFlag) | declaration, target });
    }

    const classAt = lines.find(({ line }) => classLine.test(line));
    const simpleName = escapeLiteral(internalName.slice(internalName.lastIndexOf('/') + 1));
    const nameStart = classAt?.line.indexOf(` ${simpleName} `) ?? -1;
    if (classAt && nameStart >= 0) {
        addRow(internalName, classAt.start + nameStart + 1, simpleName.length);
    }

    // pairs the fields, then the methods with their first lines, because the disassembler writes them in this order
    const memberLines = lines.filter(({ line }) => memberLine.test(line));
    const members = [
        ...node.fields.map(field => ({ member: field, findName: (line: string) => findFieldName(line, escapeLiteral(field.name.string)) })),
        ...node.methods.map(method => ({ member: method, findName: (line: string) => findMethodName(line, method.name.string, simpleName) })),
    ];
    for (const [index, { member, findName }] of members.entries()) {
        const at = memberLines[index];
        const found = at && findName(at.line);
        if (at && found.start > 0) {
            addRow(`${internalName}#${member.name.string}#${member.type.string}`, at.start + found.start, found.length);
        }
    }

    return tokens;
}

/**
 * Returns the tokens of the members and classes in the operands of a class's instructions that have rows in the open
 * files, in a class's text that starts at `offset` in the document. Takes the first open file first.
 */
function referRows(files: OpenFiles, fileId: number, text: string, offset: number): Token[] {
    const tokens: Token[] = [];
    let lineStart = 0;

    function addRow(start: number, length: number, found: FoundRow | 'hidden' | undefined) {
        if (found === undefined || found === 'hidden') {
            return;
        }

        const { kind, flags, key } = files.get(found.fileId)!.rows[found.index];
        tokens.push({ start: offset + start, length, kind, flags: flags & ~documentFlag, target: formatTarget({ fileId: found.fileId, key }) });
    }

    for (const line of text.split('\n')) {
        const [, opcode, operands] = instructionLine.exec(line) ?? [];
        const operandsStart = lineStart + line.length - (operands?.length ?? 0);
        if (opcode && memberInstructions.test(opcode)) {
            const [owner, name, descriptor] = operands.split(' ');
            addRow(operandsStart + owner.length + 1, name.length, findMember(files, owner, name, descriptor, fileId));
        } else if (opcode && classInstructions.includes(opcode)) {
            const [name] = operands.split(' ');
            addRow(operandsStart, name.length, findKeyRow(files, name, fileId));
        }

        lineStart += line.length + 1;
    }

    return tokens;
}

/**
 * Disassembles a top class of an open file with every class nested in it, each like `javap` writes it, below the top
 * class's source file, package and the imports of all the classes. The class and member lines declare their rows. A
 * member or class in an instruction's operands points at its row in the open files. Gives the worker's message loop a
 * turn between classes and throws once the signal aborts.
 */
export async function writeBytecode(files: OpenFiles, fileId: number, top: string, signal: AbortSignal): Promise<Reply<Document>> {
    const yieldTurn = createYielder(signal);
    const file = files.get(fileId)!;
    const nested = [...file.classes.keys()].filter(name => name !== top && findTop(file, name) === top);
    const names = [top, ...nested.sort()];
    const documentImports = new Set(names.map(name => `import ${escapeLiteral(name).replaceAll('/', '.')};`));
    const parsed: { name: string; node: Node; head: RegExpExecArray; body: string }[] = [];

    for (const name of names) {
        await yieldTurn();

        const bytes = await file.zip.read(file.classes.get(name)!.entry).catch(() => null);
        if (!bytes) {
            return failed(`The engine can't read ${name} from ${file.name}.`);
        }

        try {
            const node = readClass(bytes);
            const classText = disassemble(node, { fullyQualified: false });
            const head = classHead.exec(classText)!;
            parsed.push({ name, node, head, body: classText.slice(head[0].length) });
        } catch (error) {
            return failed(`The engine can't disassemble ${name}: ${readMessage(error)}`);
        }
    }

    signal.throwIfAborted();

    const imports = parsed.flatMap(({ head }) => head[3].split('\n')).filter(line => line !== '' && !documentImports.has(line));
    const [, source = '', packageLine = ''] = parsed[0].head;
    const tokens: Token[] = [];
    let text = source + packageLine + (imports.length > 0 ? `${[...new Set(imports)].join('\n')}\n\n` : '');
    for (const [index, { name, node, body }] of parsed.entries()) {
        if (index > 0) {
            text += '\n\n';
        }

        tokens.push(...declareRows(file, fileId, name, node, body, text.length));
        tokens.push(...referRows(files, fileId, body, text.length));
        text += body;
    }

    tokens.sort((first, second) => first.start - second.start);

    return ok(writeTokens(`${text}\n`, tokens, []));
}
