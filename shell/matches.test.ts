import { expect, test } from 'bun:test';
import { pickMatches } from './matches';

function pickTexts(texts: string[], query: string, count = 10): string[] {
    return pickMatches(texts.map(text => ({ text })), query, count).map(item => item.text);
}

test('pickMatches finds `GetArea` for `GtAr` and leaves out the texts without the letters in order', () => {
    expect(pickTexts(['GetArea', 'Shape', 'Gather'], 'GtAr')).toEqual(['GetArea']);
});

test('pickMatches puts a text equal to the query first, then a text that starts with the query, then a text with the query inside', () => {
    expect(pickTexts(['GetArea', 'AreaOf', 'Area'], 'Area')).toEqual(['Area', 'AreaOf', 'GetArea']);
});

test('pickMatches returns at most the count and keeps a better match that comes after the count', () => {
    const texts = [...Array.from({ length: 5 }, (_, index) => `GetArea${index}`), 'Area'];

    expect(pickTexts(texts, 'Area', 3)).toEqual(['Area', 'GetArea0', 'GetArea1']);
});

test("pickMatches keeps the items' order among texts with the same score", () => {
    expect(pickTexts(['Class3', 'Class1', 'Class2'], 'Class', 2)).toEqual(['Class3', 'Class1']);
});
