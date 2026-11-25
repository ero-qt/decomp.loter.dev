import { expect, test } from 'bun:test';
import type { Row } from '#contract/rows';
import { type Accessibility, flagsOf, type Kind, type Modifier } from '#contract/symbols';
import { compareRows, findRowIndex, writeTooltip } from './rows';

function createRow(kind: Kind, name: string, detail = '', accessibility: Accessibility = 'public', ...modifiers: Modifier[]): Row {
    return { kind, flags: flagsOf(accessibility, ...modifiers), parent: -1, key: 0, name, detail, hiddenViews: 0 };
}

function sortNames(...rows: Row[]): string[] {
    return rows.toSorted(compareRows).map(row => row.name);
}

test('compareRows puts namespaces before types and sorts both by name', () => {
    const rows = [
        createRow('class', 'Zeta'),
        createRow('namespace', 'Beta'),
        createRow('struct', 'Alpha'),
        createRow('namespace', 'Alpha.Inner'),
    ];

    expect(sortNames(...rows)).toEqual(['Alpha.Inner', 'Beta', 'Alpha', 'Zeta']);
});

test('compareRows puts sections before namespaces and sorts them by name', () => {
    const rows = [
        createRow('namespace', 'Alpha'),
        createRow('section', 'Resources', '', ''),
        createRow('class', 'Zeta'),
        createRow('section', 'References', '', ''),
    ];

    expect(sortNames(...rows)).toEqual(['References', 'Resources', 'Alpha', 'Zeta']);
});

test('compareRows sorts the types of every kind together by name', () => {
    const rows = [
        createRow('annotation', 'G'),
        createRow('record', 'F'),
        createRow('delegate', 'E'),
        createRow('enum', 'D'),
        createRow('interface', 'C'),
        createRow('struct', 'B'),
        createRow('class', 'A'),
    ];

    expect(sortNames(...rows)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
});

test('compareRows puts nested types before members and sorts members by kind, then by name', () => {
    const rows = [
        createRow('operator', 'op_Addition'),
        createRow('method', 'Scale'),
        createRow('method', 'Area'),
        createRow('constructor', 'Shape'),
        createRow('event', 'Changed'),
        createRow('indexer', 'this[]'),
        createRow('property', 'Name'),
        createRow('field', 'sides'),
        createRow('class', 'Part'),
    ];

    expect(sortNames(...rows)).toEqual(['Part', 'sides', 'Name', 'this[]', 'Changed', 'Shape', 'Area', 'Scale', 'op_Addition']);
});

test("compareRows keeps enum members in the engine's order before the other members", () => {
    const rows = [
        createRow('method', 'ToText'),
        createRow('enum_member', 'Red'),
        createRow('enum_member', 'Green'),
        createRow('enum_member', 'Blue'),
    ];

    expect(sortNames(...rows)).toEqual(['Red', 'Green', 'Blue', 'ToText']);
});

test("writeTooltip writes a row's accessibility, static mark, name and detail", () => {
    const largest = createRow('method', 'Largest', '(Shape, Shape)', 'public', 'static', 'extern');

    expect(writeTooltip(largest)).toBe('public static Largest (Shape, Shape)');
    expect(writeTooltip(createRow('field', 'sides', '', 'private protected', 'readonly'))).toBe('private protected sides');
    expect(writeTooltip(createRow('enum_member', 'Red', '= 0'))).toBe('public Red = 0');
});

test('writeTooltip writes only the name of a row without an accessibility, a static mark or a detail', () => {
    expect(writeTooltip(createRow('namespace', 'Drawing', '', ''))).toBe('Drawing');
});

test("findRowIndex finds the index of the first row with each key and -1 for a key that isn't a row's key", () => {
    const rows = [5, 3, 9, 3].map(key => ({ ...createRow('class', `Class${key}`), key }));

    expect([5, 3, 9, 4].map(key => findRowIndex(rows, key))).toEqual([0, 1, 2, -1]);
});
