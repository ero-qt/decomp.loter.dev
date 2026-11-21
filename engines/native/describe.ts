import type { Description } from '../../contract/engine';
import { describeType } from './class-document';
import type { NativeRows } from './rows';

const functionKinds = ['method', 'constructor', 'operator'];
const scopeKinds = ['namespace', 'class'];

// returns a row's name with the names of the namespaces and classes around it, like `geometry::Rect::area`
function findFullName({ rows }: NativeRows, index: number): string {
    const names = [rows[index].name];
    for (let at = rows[index].parent; at >= 0 && scopeKinds.includes(rows[at].kind); at = rows[at].parent) {
        names.unshift(rows[at].name);
    }

    return names.join('::');
}

/**
 * Describes the row at an index. A function shows its signature from `describeFunction`, else the signature line of
 * its decompiled C when `decompiled` has it, else its name with empty parameters. Facts give the address and size of
 * functions and globals and the library of an import.
 */
export function describeRow(
    listing: NativeRows,
    index: number,
    describeFunction: (address: bigint) => string | undefined,
    decompiled: string | undefined,
): Description {
    const { rows, keys, sizes } = listing;
    const row = rows[index];
    const parent = rows[row.parent];
    const fullName = findFullName(listing, index);
    const container = parent && scopeKinds.includes(parent.kind) ? findFullName(listing, row.parent) : null;
    const address = keys.addresses.get(row.key);
    const size = sizes.get(row.key) ?? 0;

    let text = scopeKinds.includes(row.kind) ? `${row.kind} ${fullName}` : row.name;
    if (address !== undefined && functionKinds.includes(row.kind)) {
        const signatureLine = /^([^{]*)\n\{/.exec(decompiled ?? '')?.[1].replace(/\s+/g, ' ').trim();
        text = describeFunction(address)?.replace(/;$/, '') ?? signatureLine ?? `${row.name}()`;
    } else if (address !== undefined) {
        text = `${describeType(size)} ${fullName}`;
    }

    const facts: [string, string][] = [];
    if (address !== undefined) {
        facts.push(['address', `0x${address.toString(16)}`]);
    }
    if (address !== undefined && size > 0) {
        facts.push(['size', String(size)]);
    }
    if (parent?.kind === 'reference') {
        facts.push(['library', parent.name]);
    }

    return { text, container, facts, missingFile: null };
}
