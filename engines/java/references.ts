import { formatTarget, parseTarget } from '../../contract/document';
import type { Reference } from '../../contract/engine';
import { createYielder } from '../shared/yielding';
import { type OpenFiles, splitMemberKey } from './describe';
import { findTop, type JavaClass } from './files';

/** The keys of a target's symbol and whether the symbol is a member. */
interface TargetKeys {
    keys: string[];
    isMember: boolean;
}

function hasClass(files: OpenFiles, name: string): boolean {
    return [...files.values()].some(file => file.classes.has(name));
}

// returns a row's own key with the keys of its aliases, like a record component's accessor, the key of a symbol outside
// the open files, or nothing for a package, a local and a closed file's row
function readTargetKeys(files: OpenFiles, target: string): TargetKeys {
    const parsed = parseTarget(target);
    if ('outside' in parsed) {
        const isClass = hasClass(files, parsed.outside) || !splitMemberKey(parsed.outside);

        return { keys: [parsed.outside], isMember: !isClass };
    }

    if (!('fileId' in parsed)) {
        return { keys: [], isMember: false };
    }

    const file = files.get(parsed.fileId);
    const key = file?.rowKeys[parsed.key];
    if (!file || key === undefined || key.endsWith('/')) {
        return { keys: [], isMember: false };
    }

    return { keys: [...file.keys].filter(([, index]) => index === parsed.key).map(([found]) => found), isMember: !file.classes.has(key) };
}

function findClass(files: OpenFiles, name: string): JavaClass | undefined {
    return [...files.values()].find(file => file.classes.has(name))?.classes.get(name);
}

// checks whether a member reference with an owner uses the member of the target's owner, which it does through a class
// that extends the target's owner unless a class on the way declares the member again
function reachesOwner(files: OpenFiles, owner: string, member: string, targetOwner: string): boolean {
    const queue = [owner];
    const seen = new Set(queue);

    while (queue.length > 0) {
        const current = queue.shift()!;
        const found = findClass(files, current);
        if (current === targetOwner) {
            return true;
        }
        if (!found || found.members.some(({ key }) => key === `${current}#${member}`)) {
            continue;
        }

        for (const next of [found.symbols.superName, ...found.symbols.interfaces]) {
            if (next !== undefined && !seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }

    return false;
}

function usesMember(files: OpenFiles, { uses }: JavaClass, keys: string[]): boolean {
    const isOwner = (name: string) => hasClass(files, name);
    const targets = keys.flatMap(key => splitMemberKey(key, isOwner) ?? []);

    return [...uses.members].some(used => {
        const member = splitMemberKey(used, isOwner);

        return targets.some(target => {
            const isSame = member !== undefined && member.name === target.name && member.descriptor === target.descriptor;

            return isSame && reachesOwner(files, member.owner, `${member.name}#${member.descriptor}`, target.owner);
        });
    });
}

/**
 * Finds the top classes of the open files whose code uses a target's symbol, each as 1 user without places. Matches a
 * class by its name and a member by its name, descriptor and owner. Leaves out a class whose top class doesn't have a
 * row. Gives the worker's message loop a turn between classes and throws once the signal aborts.
 */
export async function findUsers(files: OpenFiles, target: string, signal: AbortSignal): Promise<Reference[]> {
    const yieldTurn = createYielder(signal);
    signal.throwIfAborted();

    const { keys, isMember } = readTargetKeys(files, target);
    const users = new Set<string>();

    for (const [fileId, file] of files) {
        for (const [name, found] of file.classes) {
            await yieldTurn();

            const top = file.keys.get(findTop(file, name));
            const uses = isMember ? usesMember(files, found, keys) : keys.some(key => found.uses.classes.has(key));
            if (uses && top !== undefined) {
                users.add(formatTarget({ fileId, key: top }));
            }
        }
    }

    return [...users].map(user => ({ user, ranges: null }));
}
