import type { SymbolKind } from 'vscode';
import type { Row } from '../contract/rows';
import { accessibilityOf, type Kind, modifiersOf } from '../contract/symbols';

// kind -> the place of the kind's rows below a row
const places: Record<Kind, number> = {
    namespace: 0,
    class: 1,
    struct: 1,
    interface: 1,
    enum: 1,
    delegate: 1,
    enum_member: 2,
    field: 3,
    property: 4,
    indexer: 5,
    event: 6,
    constructor: 7,
    method: 8,
    operator: 9,
    parameter: 10,
    local: 10,
    type_parameter: 10,
    label: 10,
    opcode: 10,
    record: 1,
    annotation: 1,
    section: -1,
    reference: 0,
    resource: 0,
};

/**
 * The outline's symbol kind of each kind. A kind that the outline doesn't have gets the nearest symbol kind, like
 * `Class` for a delegate or a record.
 */
export const symbolKinds: Record<Kind, keyof typeof SymbolKind> = {
    namespace: 'Namespace',
    class: 'Class',
    struct: 'Struct',
    interface: 'Interface',
    enum: 'Enum',
    delegate: 'Class',
    method: 'Method',
    constructor: 'Constructor',
    operator: 'Operator',
    property: 'Property',
    indexer: 'Property',
    field: 'Field',
    enum_member: 'EnumMember',
    event: 'Event',
    parameter: 'Variable',
    local: 'Variable',
    type_parameter: 'TypeParameter',
    label: 'Key',
    opcode: 'Operator',
    record: 'Class',
    annotation: 'Interface',
    section: 'Package',
    reference: 'Module',
    resource: 'File',
};

// compares names without case and numbers by value because a file manager sorts files that way
export const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Compares 2 rows below the same row for the Symbols view. Sections come before namespaces, namespaces before types and
 * types before members, members sort by kind and rows with the same place sort by name, but enum members keep the
 * engine's order.
 */
export function compareRows(first: Row, second: Row): number {
    return places[first.kind] - places[second.kind] || (first.kind === 'enum_member' ? 0 : nameCollator.compare(first.name, second.name));
}

/** Writes a row's tooltip, like `public static Largest (Shape, Shape)`. */
export function writeTooltip({ flags, name, detail }: Row): string {
    const isStatic = modifiersOf(flags).includes('static');

    return [accessibilityOf(flags), isStatic ? 'static' : '', name, detail].filter(Boolean).join(' ');
}

// listing's rows -> each key's first row index
const rowIndexes = new WeakMap<Row[], Map<number, number>>();

/**
 * Finds the index of the first row with the key, or -1 when no row has the key. Keeps a map of the rows' keys for each
 * listing because a reference search finds a row for each of hundreds of users.
 */
export function findRowIndex(rows: Row[], key: number): number {
    let indexes = rowIndexes.get(rows);
    if (!indexes) {
        indexes = new Map();
        for (const [index, row] of rows.entries()) {
            if (!indexes.has(row.key)) {
                indexes.set(row.key, index);
            }
        }
        rowIndexes.set(rows, indexes);
    }

    return indexes.get(key) ?? -1;
}
