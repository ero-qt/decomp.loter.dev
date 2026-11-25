import { findDocumentRow, type Row } from '#contract/rows';

/** A row that a search can find by its name, with the row's index in its file's rows. */
export interface NameCandidate {
    index: number;
    text: string;
}

// a file's rows -> the rows' names for a search, because a search runs on each key that the user types
const namesByRows = new WeakMap<Row[], NameCandidate[]>();
// a file's rows -> each row's top row
const rootsByRows = new WeakMap<Row[], Int32Array>();
// a file's rows -> each row's index by the row's key
const indexesByRows = new WeakMap<Row[], Map<number, number>>();

/**
 * Lists the rows of a file that a search finds by name: those that the first view shows, like the Symbols view, and
 * that a document shows. Lists the same rows once.
 */
export function listNames(rows: Row[]): NameCandidate[] {
    let names = namesByRows.get(rows);
    if (!names) {
        names = rows.flatMap((row, index) => (row.hiddenViews & 1 || findDocumentRow(rows, index) === undefined ? [] : [{ index, text: row.name }]));
        namesByRows.set(rows, names);
    }

    return names;
}

/** Finds the index of the top row above a row, like the row of a namespace or of an assembly. */
export function findRoot(rows: Row[], index: number): number {
    let roots = rootsByRows.get(rows);
    if (!roots) {
        // reads each row's root from its parent's because a parent comes before its rows
        roots = new Int32Array(rows.length);
        for (const [current, { parent }] of rows.entries()) {
            roots[current] = parent < 0 ? current : roots[parent];
        }

        rootsByRows.set(rows, roots);
    }

    return roots[index];
}

/** Finds the index of the row with a key in a file's rows, or `undefined`. */
export function findRowIndex(rows: Row[], key: number): number | undefined {
    let indexes = indexesByRows.get(rows);
    if (!indexes) {
        indexes = new Map(rows.map((row, index) => [row.key, index]));
        indexesByRows.set(rows, indexes);
    }

    return indexes.get(key);
}
