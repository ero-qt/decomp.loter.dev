import { expect, test } from 'bun:test';
import { findDocumentRow, readRows, type Row, writeRows } from './rows';
import { flagsOf } from './symbols';

const rows: Row[] = [
    { kind: 'namespace', flags: 0, parent: -1, key: 0, name: 'Shapes', detail: '', hiddenViews: 0 },
    { kind: 'enum', flags: flagsOf('public'), parent: 0, key: 0x02000002, name: 'Color', detail: '', hiddenViews: 0 },
    { kind: 'enum_member', flags: flagsOf('public', 'static', 'const'), parent: 1, key: 0x04000001, name: 'Red', detail: '= 0', hiddenViews: 0 },
];

test('rows come back the same from their written form', () => {
    expect(readRows(writeRows(rows))).toEqual(rows);
});

test('rows hidden in views come back the same from their written form', () => {
    const hidden = [rows[0], { ...rows[1], hiddenViews: 1 }, { ...rows[2], hiddenViews: 3 }];

    expect(readRows(writeRows(hidden))).toEqual(hidden);
});

test('readRows refuses a row that shows in a view that hides its parent', () => {
    const shown = writeRows([rows[0], { ...rows[1], hiddenViews: 2 }, { ...rows[2], hiddenViews: 1 }]);

    expect(() => readRows(shown)).toThrow('row 2 shows in a view that hides its parent');
});

test('readRows refuses a row whose parent is the row or a later row', () => {
    const own = writeRows([{ ...rows[0], parent: 0 }]);
    const later = writeRows([{ ...rows[0], parent: 1 }, rows[1]]);

    expect(() => readRows(own)).toThrow("row 0 has the parent 0, which isn't an earlier row");
    expect(() => readRows(later)).toThrow("row 0 has the parent 1, which isn't an earlier row");
});

test('readRows refuses an unknown kind', () => {
    const written = writeRows(rows);
    written.values[0] = 99;

    expect(() => readRows(written)).toThrow('row 0 has the unknown kind 99');
});

test('readRows refuses rows without a name and a detail for each row', () => {
    const names = writeRows(rows);
    const details = writeRows(rows);
    names.names.pop();
    details.details.pop();

    expect(() => readRows(names)).toThrow('3 rows have 2 names and 3 details');
    expect(() => readRows(details)).toThrow('3 rows have 3 names and 2 details');
});

test("readRows refuses a name or a detail that isn't a string", () => {
    const names = writeRows(rows);
    const details = writeRows(rows);
    names.names[1] = 3 as unknown as string;
    details.details[2] = null as unknown as string;

    expect(() => readRows(names)).toThrow("row 1 has a name or a detail that isn't a string");
    expect(() => readRows(details)).toThrow("row 2 has a name or a detail that isn't a string");
});

test('readRows refuses values that end inside a row', () => {
    const written = writeRows(rows);

    expect(() => readRows({ ...written, values: written.values.subarray(0, 12) })).toThrow("12 values aren't 5 for each row");
});

test('findDocumentRow finds the nearest row at or above a row with the `document` modifier', () => {
    const typeRows: Row[] = [
        rows[0],
        { ...rows[1], flags: flagsOf('public', 'document') },
        rows[2],
        { ...rows[2], parent: 2, key: 0x04000002, name: 'Green' },
    ];

    expect([0, 1, 2, 3].map(index => findDocumentRow(typeRows, index))).toEqual([undefined, 1, 1, 1]);
    expect(findDocumentRow(rows, 2)).toBeUndefined();
});
