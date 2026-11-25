import { formatTarget, parseTarget } from '#contract/document';
import type { Description } from '#contract/engine';
import { type MethodType, tryParseType, type Type } from '@katana-project/asm/type';
import type { OpenFile } from './handlers';
import { simpleName, writeType } from './types';

/** The open files by id. */
export type OpenFiles = Map<number, OpenFile>;

/** A row of an open file. */
export interface FoundRow {
    fileId: number;
    index: number;
}

/** A member key's parts, like `drawing/Main`, `sum` and `([I)I` for `drawing/Main#sum#([I)I`. */
export interface MemberKey {
    owner: string;
    name: string;
    descriptor: string;
    /** The descriptor's type. */
    type: Type;
}

function writeDottedName(name: string): string {
    return name.replaceAll('/', '.').replaceAll('$', '.');
}

function parseDescriptor(text: string): Type | undefined {
    const type = tryParseType(text);

    return type?.value === text ? type : undefined;
}

/**
 * Splits a member key, or returns `undefined` for a class's key. Takes the descriptor after the last `#` whose rest is
 * a whole descriptor. Takes the owner before the last `#` before it whose start `hasOwner` accepts, or before the last
 * `#` when `hasOwner` accepts none, because a class's or member's name can have a `#` too.
 */
export function splitMemberKey(key: string, hasOwner: (owner: string) => boolean = () => false): MemberKey | undefined {
    let descriptorAt = key.lastIndexOf('#');
    let type = parseDescriptor(key.slice(descriptorAt + 1));
    while (descriptorAt > 0 && !type) {
        descriptorAt = key.lastIndexOf('#', descriptorAt - 1);
        type = parseDescriptor(key.slice(descriptorAt + 1));
    }

    const ownerEnds: number[] = [];
    for (let at = key.lastIndexOf('#', descriptorAt - 1); at > 0; at = key.lastIndexOf('#', at - 1)) {
        ownerEnds.push(at);
    }

    const ownerEnd = ownerEnds.find(at => hasOwner(key.slice(0, at))) ?? ownerEnds[0];
    if (!type || descriptorAt <= 0 || ownerEnd === undefined || ownerEnd + 1 === descriptorAt) {
        return undefined;
    }

    return { owner: key.slice(0, ownerEnd), name: key.slice(ownerEnd + 1, descriptorAt), descriptor: key.slice(descriptorAt + 1), type };
}

/** Finds the row of a class or member key in the open files, the first file first. */
export function findKeyRow(files: OpenFiles, key: string, first?: number): FoundRow | undefined {
    const order = first === undefined ? [...files.keys()] : [first, ...[...files.keys()].filter(fileId => fileId !== first)];

    for (const fileId of order) {
        const index = files.get(fileId)?.keys.get(key);
        if (index !== undefined) {
            return { fileId, index };
        }
    }

    return undefined;
}

/**
 * Finds the row of a member of a class or of a class that the class extends or implements, because code uses an
 * inherited member with the subclass as the owner. Returns `'hidden'` for a member that an open file has without a row,
 * like a lambda's method, and `undefined` for a member that no open file has.
 */
export function findMember(files: OpenFiles, owner: string, name: string, descriptor: string, first?: number): FoundRow | 'hidden' | undefined {
    const queue = [owner];
    const seen = new Set(queue);

    while (queue.length > 0) {
        const current = queue.shift()!;
        const key = `${current}#${name}#${descriptor}`;
        const found = findKeyRow(files, key, first);
        if (found) {
            return found;
        }
        if ([...files.values()].some(file => file.hiddenKeys.has(key))) {
            return 'hidden';
        }

        const symbols = [...files.values()].find(file => file.classes.has(current))?.classes.get(current)?.symbols;
        for (const next of [symbols?.superName, ...(symbols?.interfaces ?? [])]) {
            if (next !== undefined && !seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }

    return undefined;
}

// returns the row of an open file that a row target points at
function findTargetRow(files: OpenFiles, target: string): FoundRow | undefined {
    const parsed = parseTarget(target);
    if (!('fileId' in parsed) || !files.get(parsed.fileId)?.rows[parsed.key]) {
        return undefined;
    }

    return { fileId: parsed.fileId, index: parsed.key };
}

function describeRow(file: OpenFile, index: number): Description | null {
    const key = file.rowKeys[index];
    if (key.endsWith('/')) {
        return { text: `package ${file.rows[index].name}`, container: null, facts: [], missingFile: null };
    }

    const isClass = file.classes.has(key);
    const owner = isClass ? key : splitMemberKey(key, name => file.classes.has(name))?.owner;
    const found = owner === undefined ? undefined : file.classes.get(owner);
    const signature = isClass ? found?.symbols.signature : found?.members.find(member => member.key === key)?.signature;
    if (owner === undefined || signature === undefined) {
        return null;
    }

    const outer = isClass ? file.outers.get(owner) : owner;
    const folder = owner.slice(0, Math.max(0, owner.lastIndexOf('/')));
    const container = outer !== undefined ? writeDottedName(outer) : folder === '' ? null : writeDottedName(folder);

    return { text: signature, container, facts: [], missingFile: null };
}

// writes the declaration of a symbol outside the open files from its key, like `String trim()`
function describeKey(key: string): Description {
    const member = splitMemberKey(key);
    if (!member) {
        return { text: writeDottedName(key), container: null, facts: [], missingFile: null };
    }

    const { owner, name, type } = member;
    const container = writeDottedName(owner);
    const { parameters, returnType } = type as Partial<MethodType>;
    if (!parameters || !returnType) {
        return { text: `${writeType(type)} ${name}`, container, facts: [], missingFile: null };
    }

    const shownName = name === '<init>' ? simpleName(owner).split('.').at(-1)! : name;
    const returned = name === '<init>' ? '' : `${writeType(returnType)} `;

    return { text: `${returned}${shownName}(${parameters.map(writeType).join(', ')})`, container, facts: [], missingFile: null };
}

/**
 * Describes a row target of an open file or a symbol outside the open files, or returns `null` for any other target.
 */
export function describeTarget(files: OpenFiles, target: string): Description | null {
    const parsed = parseTarget(target);
    const found = findTargetRow(files, target);
    if (found) {
        return describeRow(files.get(found.fileId)!, found.index);
    }

    return 'outside' in parsed ? describeKey(parsed.outside) : null;
}

/** Returns the row target of a symbol outside the open files, the same target for a row target, or `null`. */
export function resolveTarget(files: OpenFiles, target: string): string | null {
    const parsed = parseTarget(target);
    if (!('outside' in parsed)) {
        return findTargetRow(files, target) ? target : null;
    }

    const member = splitMemberKey(parsed.outside, owner => [...files.values()].some(file => file.classes.has(owner)));
    const found = findKeyRow(files, parsed.outside) ?? (member && findMember(files, member.owner, member.name, member.descriptor));

    return found === undefined || found === 'hidden' ? null : formatTarget({ fileId: found.fileId, key: found.index });
}
