import type { Row } from '#contract/rows';
import { type Accessibility, flagsOf, type Kind, type Modifier } from '#contract/symbols';
import { expect, test } from 'bun:test';
import { isBlank, isInPlace, matchesRow, parseQuery } from './query';

function row(name: string, kind: Kind, parent: number, accessibility: Accessibility = 'public', ...modifiers: Modifier[]): Row {
    return { kind, flags: flagsOf(accessibility, ...modifiers), parent, key: 0, name, detail: '', hiddenViews: 0 };
}

const rows = [
    row('Shapes', 'namespace', -1),
    row('Shape', 'class', 0, 'public', 'abstract'),
    row('Area', 'method', 1, 'protected internal', 'virtual'),
    row('count', 'field', 1, 'private', 'static', 'readonly'),
    row('Point', 'struct', 0, 'internal'),
];

function find(value: string): string[] {
    const query = parseQuery(value);

    return rows.filter((_, index) => matchesRow(query, rows, index)).map(found => found.name);
}

test('a query has its text, the container before the last dot and the filters in any order and case', () => {
    expect(parseQuery('kind:method,Property Shape.Area IS:public in:Shapes.dll')).toEqual({
        text: 'Area',
        container: 'shape',
        isStrings: false,
        kinds: new Set(['method', 'property']),
        words: ['public'],
        places: ['shapes.dll'],
    });
    expect(parseQuery('get area').text).toBe('get area');
});

test('a quote starts a string search whose text runs to the end, after the filters', () => {
    expect(parseQuery('in:java "kind: a b')).toMatchObject({ text: 'kind: a b', isStrings: true, places: ['java'], kinds: new Set() });
    expect(parseQuery('say "hi"')).toMatchObject({ text: 'say "hi"', isStrings: false });
});

test('a query without a text or a filter is blank', () => {
    expect(['', '  ', 'kind:', '"'].map(value => isBlank(parseQuery(value)))).toEqual([true, true, false, true]);
    expect(isBlank(parseQuery('is:static'))).toBe(false);
});

test('kind: finds the rows of its kinds, and `type` stands for the kinds of types', () => {
    expect(find('kind:method,field')).toEqual(['Area', 'count']);
    expect(find('kind:type')).toEqual(['Shape', 'Point']);
    expect(find('kind:nothing')).toEqual([]);
});

test('is: finds the rows with each of its accessibility words and modifiers', () => {
    expect(find('is:public')).toEqual(['Shapes', 'Shape']);
    expect(find('is:protected')).toEqual(['Area']);
    expect(find('is:internal')).toEqual(['Area', 'Point']);
    expect(find('is:static,readonly')).toEqual(['count']);
    expect(find('is:static is:virtual')).toEqual([]);
});

test('a container finds the rows below a row with the text in its name', () => {
    expect(find('ape.Area')).toEqual(['Shape', 'Area', 'count', 'Point']);
    expect(find('Shapes.Shape')).toEqual(['Shape', 'Point']);
    expect(find('count.')).toEqual([]);
});

test("in: finds a file by a part of its path or by its engine, and a row by a part of its top row's name", () => {
    const isIn = (value: string, index = 2) => isInPlace(parseQuery(value), 'lib/Drawing.dll', 'dotnet', rows, index);

    expect(['in:drawing', 'in:dotnet', 'in:shapes', 'in:lib/ in:dotnet'].map(value => isIn(value))).toEqual([true, true, true, true]);
    expect(['in:java', 'in:dot', 'in:drawing in:java'].map(value => isIn(value))).toEqual([false, false, false]);
    expect(isIn('in:shapes', -1)).toBe(false);
});
