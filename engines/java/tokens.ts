import { formatTarget, type Token } from '#contract/document';
import { flagsOf, type Kind } from '#contract/symbols';
import type { Node } from '@katana-project/asm';
import { findLocalType, readClass } from './classfile';
import { findKeyRow, findMember, type FoundRow, type OpenFiles } from './describe';
import type { OpenFile } from './handlers';

/** A token that Vineflower reports while it writes a class. */
export interface VineflowerToken {
    kind: 'class' | 'field' | 'method' | 'parameter' | 'local';
    start: number;
    length: number;
    isDeclaration: boolean;
    /** The internal name of a class, or the name of a member, parameter or local. */
    name: string;
    /** The internal name of the class of a member, or of the method of a parameter or local. */
    owner: string;
    /** The descriptor of a member, or of the method of a parameter or local. */
    descriptor: string;
    /** The name of the method of a parameter or local. */
    method: string;
    /** The index of a parameter or local in its method's locals. */
    index: number;
}

/**
 * Reads a class's bytes from an open file, the first file first, or returns `null` for a class that no open file has.
 */
export async function readAnyClass(files: OpenFiles, first: number, name: string): Promise<Uint8Array | null> {
    for (const file of [files.get(first)!, ...files.values()]) {
        const found = file.classes.get(name);
        if (found) {
            return file.zip.read(found.entry).catch(() => null);
        }
    }

    return null;
}

function findClass(files: OpenFiles, name: string) {
    return [...files.values()].find(file => file.classes.has(name))?.classes.get(name);
}

function isLocalToken({ kind }: VineflowerToken): boolean {
    return kind === 'parameter' || kind === 'local';
}

function readLocalKey({ owner, method, descriptor, index, name }: VineflowerToken): string {
    return [owner, method, descriptor, index, name].join('#');
}

function readSymbolKey({ kind, owner, name, descriptor }: VineflowerToken): string {
    return kind === 'class' ? name : `${owner}#${name}#${descriptor}`;
}

function readSymbolKind({ kind, name }: VineflowerToken): Kind {
    if (kind === 'method') {
        return name === '<init>' ? 'constructor' : 'method';
    }

    return kind === 'field' ? 'field' : 'class';
}

// returns the row index of the record component that a parameter of the record's canonical constructor stands for
function findComponent(file: OpenFile, { owner, name, method, descriptor }: VineflowerToken): number | undefined {
    if (method !== '<init>' || descriptor !== file.classes.get(owner)?.symbols.recordConstructor) {
        return undefined;
    }

    const field = file.classes.get(owner)!.members.find(member => member.kind === 'field' && member.name === name);

    return field && file.keys.get(field.key);
}

// drops a token that starts before the end of the token before it or crosses a line end, which the contract refuses
function sortTokens(text: string, tokens: VineflowerToken[]): VineflowerToken[] {
    const sorted: VineflowerToken[] = [];

    for (const token of tokens.toSorted((first, second) => first.start - second.start)) {
        const before = sorted.at(-1);
        const crossesLine = text.slice(token.start, token.start + token.length).includes('\n');
        if (!crossesLine && (!before || token.start >= before.start + before.length)) {
            sorted.push(token);
        }
    }

    return sorted;
}

/**
 * Turns the tokens that Vineflower reports for a document of an open file into the contract's tokens and locals. A
 * symbol with a row points at the row, and a record component's accessor and its canonical constructor's undeclared
 * parameters at the component's row. A parameter, a local, and a local class or a member without a row that the
 * document declares point at a local. A class or member that no open file has points outside the open files. Marks the
 * first use of a local that Vineflower doesn't declare, like a catch variable, as its declaration.
 */
export async function mapTokens(files: OpenFiles, fileId: number, text: string, reported: VineflowerToken[]) {
    const file = files.get(fileId)!;
    const sorted = sortTokens(text, reported);
    const declaredLocals = new Set(sorted.filter(token => isLocalToken(token) && token.isDeclaration).map(readLocalKey));
    const declaredSymbols = new Set(sorted.filter(token => !isLocalToken(token) && token.isDeclaration).map(readSymbolKey));

    // local key or symbol key -> the local's target
    const localTargets = new Map<string, string>();
    const locals: string[] = [];
    const nodes = new Map<string, Node | null>();
    const tokens: Token[] = [];

    async function describeLocal(token: VineflowerToken): Promise<string> {
        if (!nodes.has(token.owner)) {
            const bytes = await readAnyClass(files, fileId, token.owner);
            nodes.set(token.owner, bytes && readClass(bytes));
        }

        const node = nodes.get(token.owner);
        const type = node && findLocalType(node, token.method, token.descriptor, token.index, token.name);

        return type ? `${type} ${token.name}` : token.name;
    }

    function addLocal(key: string, declaration: string): string {
        return localTargets.get(key) ?? localTargets.set(key, formatTarget({ local: locals.push(declaration) - 1 })).get(key)!;
    }

    // leaves out the row's `document` modifier because it marks a row, not a symbol
    function addRowToken({ start, length }: VineflowerToken, { fileId: rowFileId, index }: FoundRow, flags: number) {
        const { kind, flags: rowFlags, key } = files.get(rowFileId)!.rows[index];
        const symbolFlags = rowFlags & ~flagsOf('', 'document');
        tokens.push({ start, length, kind, flags: flags | symbolFlags, target: formatTarget({ fileId: rowFileId, key }) });
    }

    for (const token of sorted) {
        const { start, length } = token;
        const flags = token.isDeclaration ? flagsOf('', 'declaration') : 0;

        if (isLocalToken(token)) {
            const key = readLocalKey(token);
            const component = declaredLocals.has(key) ? undefined : findComponent(file, token);
            if (component !== undefined) {
                addRowToken(token, { fileId, index: component }, 0);
                continue;
            }

            const isFirst = !localTargets.has(key);
            const target = addLocal(key, isFirst ? await describeLocal(token) : '');
            const firstUse = isFirst && !declaredLocals.has(key) ? flagsOf('', 'declaration') : 0;
            tokens.push({ start, length, kind: token.kind, flags: flags | firstUse, target });
            continue;
        }

        const key = readSymbolKey(token);
        const found = token.kind === 'class' ? findKeyRow(files, key, fileId) : findMember(files, token.owner, token.name, token.descriptor, fileId);
        const isOwnClass = token.kind === 'class' && findClass(files, key) !== undefined;
        if (found !== undefined && found !== 'hidden') {
            addRowToken(token, found, flags);
        } else if ((found === 'hidden' || isOwnClass) && declaredSymbols.has(key)) {
            const symbol = findClass(files, token.kind === 'class' ? key : token.owner);
            const signature = token.kind === 'class' ? symbol?.symbols.signature : symbol?.members.find(member => member.key === key)?.signature;
            tokens.push({ start, length, kind: readSymbolKind(token), flags, target: addLocal(key, signature ?? token.name) });
        } else if (found === 'hidden' || isOwnClass) {
            tokens.push({ start, length, kind: readSymbolKind(token), flags: 0, target: null });
        } else {
            tokens.push({ start, length, kind: readSymbolKind(token), flags: 0, target: formatTarget({ outside: key }) });
        }
    }

    return { tokens, locals };
}
