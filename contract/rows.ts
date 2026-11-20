import { type Kind, kinds, modifiersOf } from './symbols';

/** A symbol in the tree of a file, like a namespace, a type or a member. */
export interface Row {
    kind: Kind;
    flags: number;
    /** The index of the row that contains this row, or -1 for a row at the top. */
    parent: number;
    /** The symbol's number, which the engine picks and which is unique in the symbol's file. */
    key: number;
    name: string;
    /** The text after the name, like the value of an enum member. */
    detail: string;
    /**
     * The views whose documents don't declare the row, as the bit at each view's index in the manifest, like 1 for a
     * backing field that only the second view declares.
     */
    hiddenViews: number;
}

/** The rows of a file as an engine sends them, with 5 values for each row: kind, flags, parent, key and hiddenViews. */
export interface Rows {
    values: Int32Array;
    names: string[];
    details: string[];
}

const valuesPerRow = 5;

export function writeRows(rows: Row[]): Rows {
    const values = new Int32Array(rows.length * valuesPerRow);
    rows.forEach(({ kind, flags, parent, key, hiddenViews }, index) => {
        values.set([kinds.indexOf(kind), flags, parent, key, hiddenViews], index * valuesPerRow);
    });

    return { values, names: rows.map(row => row.name), details: rows.map(row => row.detail) };
}

/**
 * Reads the rows that an engine sent and throws for rows that break the layout, like a parent that isn't an earlier row
 * or a row that shows in a view that hides its parent.
 */
export function readRows({ values, names, details }: Rows): Row[] {
    if (values.length % valuesPerRow !== 0) {
        throw new Error(`${values.length} values aren't ${valuesPerRow} for each row`);
    }

    const count = values.length / valuesPerRow;
    if (names.length !== count || details.length !== count) {
        throw new Error(`${count} rows have ${names.length} names and ${details.length} details`);
    }

    const rows: Row[] = [];
    for (const [index, name] of names.entries()) {
        const [kindNumber, flags, parent, key, hiddenViews] = values.subarray(index * valuesPerRow, (index + 1) * valuesPerRow);
        const kind = kinds[kindNumber];
        if (kind === undefined) {
            throw new Error(`row ${index} has the unknown kind ${kindNumber}`);
        }
        if (parent < -1 || parent >= index) {
            throw new Error(`row ${index} has the parent ${parent}, which isn't an earlier row`);
        }
        if (typeof name !== 'string' || typeof details[index] !== 'string') {
            throw new Error(`row ${index} has a name or a detail that isn't a string`);
        }
        if (parent >= 0 && (rows[parent].hiddenViews & ~hiddenViews) !== 0) {
            throw new Error(`row ${index} shows in a view that hides its parent`);
        }

        rows.push({ kind, flags, parent, key, name, detail: details[index], hiddenViews });
    }

    return rows;
}

/**
 * Finds the row whose document shows a row, which is the nearest row at or above the row with the `document` modifier.
 * Returns the found row's index, or `undefined` when no row at or above the row has the modifier.
 */
export function findDocumentRow(rows: Row[], index: number): number | undefined {
    for (let current = index; current >= 0; current = rows[current].parent) {
        if (modifiersOf(rows[current].flags).includes('document')) {
            return current;
        }
    }

    return undefined;
}
