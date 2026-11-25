import type { Row } from '#contract/rows';
import { flagsOf, type Kind, type Modifier } from '#contract/symbols';
import { expect, test } from 'bun:test';
import { findRoot, listNames } from './candidates';

function row(name: string, kind: Kind, parent: number, modifiers: Modifier[] = [], hiddenViews = 0): Row {
    return { kind, flags: flagsOf('public', ...modifiers), parent, key: 0, name, detail: '', hiddenViews };
}

const rows = [
    row('Shapes', 'namespace', -1),
    row('Shape', 'class', 0, ['document']),
    row('Area', 'method', 1),
    row('backing', 'field', 1, [], 1),
    row('References', 'section', -1),
    row('mscorlib', 'reference', 4),
];

test('listNames lists the rows that the first view shows and that a document shows', () => {
    expect(listNames(rows)).toEqual([
        { index: 1, text: 'Shape' },
        { index: 2, text: 'Area' },
    ]);
});

test('listNames lists the names of the same rows once', () => {
    expect(listNames(rows)).toBe(listNames(rows));
    expect(listNames([...rows])).not.toBe(listNames(rows));
});

test('findRoot finds the top row above a row', () => {
    expect([0, 2, 5].map(index => rows[findRoot(rows, index)].name)).toEqual(['Shapes', 'Shapes', 'References']);
});
