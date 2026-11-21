import type { NativeModule } from './module';
import type { NativeRows } from './rows';

const functionKinds = ['method', 'constructor', 'operator'];

/** A function of a file with the range of its code, whose code can use other symbols. */
interface FunctionRange {
    key: number;
    start: bigint;
    end: bigint;
}

/** Finds the function whose code has an address, from the functions of a file's rows. */
export type FindFunction = (address: bigint) => number | undefined;

/**
 * Returns the function that finds the key of the function whose code has an address: the listed function with the
 * nearest start at or before the address. Leaves out an address past the end of that function, like a reference from
 * data, unless the function's size isn't known.
 */
export function createFunctionFinder({ rows, keys, sizes }: NativeRows): FindFunction {
    const ranges: FunctionRange[] = rows
        .filter(row => functionKinds.includes(row.kind) && keys.addresses.has(row.key))
        .map(({ key }) => {
            const start = keys.addresses.get(key)!;

            return { key, start, end: start + BigInt(sizes.get(key) ?? 0) };
        })
        .sort((first, second) => (first.start < second.start ? -1 : first.start > second.start ? 1 : 0));

    return address => {
        let low = 0;
        let high = ranges.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            [low, high] = ranges[middle].start <= address ? [middle + 1, high] : [low, middle];
        }

        const found = ranges[low - 1];

        return found && (found.end === found.start || address < found.end) ? found.key : undefined;
    };
}

/**
 * Returns the keys of the functions whose code refers to an address, in address order of the references, each once.
 * Finds only the references in code that Rizin searched, which the caller has it do first.
 */
export function findUsers(module: NativeModule, session: number, findFunction: FindFunction, address: bigint): number[] {
    const users = module.listReferences(session, address).map(findFunction).filter(key => key !== undefined);

    return [...new Set(users)];
}
