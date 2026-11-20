import { expect, test } from 'bun:test';
import { formatDocumentPath, parseDocumentPath } from './document-paths';

const parts = { engineId: 'fake', viewId: 'code', fileId: 1, key: 2 };

test("formatDocumentPath writes the engine's id, the view's id, the row target, the row's name and the view's extension", () => {
    expect(formatDocumentPath(parts, 'Circle', '.code')).toBe('/fake/code/1:2/Circle.code');
});

test('parseDocumentPath reads back the parts of a path with a negative key and an extension with 2 dots', () => {
    const negative = { ...parts, viewId: 'il', fileId: 12, key: -1 };

    expect(formatDocumentPath(negative, 'Shapes.Shape', '.il.txt')).toBe('/fake/il/12:ffffffff/Shapes.Shape.il.txt');
    expect(parseDocumentPath(formatDocumentPath(negative, 'Shapes.Shape', '.il.txt'))).toEqual(negative);
});

test("formatDocumentPath escapes a slash in the row's name, so the name stays the path's last segment", () => {
    const path = formatDocumentPath(parts, 'Outer/Inner', '.code');

    expect(path).toBe('/fake/code/1:2/Outer%2FInner.code');
    expect(parseDocumentPath(path)).toEqual(parts);
});

test("parseDocumentPath returns undefined for a path without a target and for a target that isn't a row target", () => {
    for (const path of ['/fake', '/fake/code/L:0/area.code', '/fake/code/x/area.code']) {
        expect(parseDocumentPath(path)).toBeUndefined();
    }
});
