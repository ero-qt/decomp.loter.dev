import { expect, test } from 'bun:test';
import { failed } from '../../contract/reply';
import type { Row } from '../../contract/rows';
import { flagsOf } from '../../contract/symbols';
import { createRefusals, findDocumentRowReply } from './refusals';

const refusals = createRefusals('Java');

const rows: Row[] = [
    { kind: 'class', flags: flagsOf('public', 'document'), parent: -1, key: 0, name: 'Circle', detail: '', hiddenViews: 0 },
    { kind: 'method', flags: flagsOf('public'), parent: 0, key: 1, name: 'draw', detail: '()', hiddenViews: 0 },
];

test("createRefusals writes the engine's name with the file id, view, key or row that the engine doesn't have", () => {
    expect(refusals.file(7)).toEqual(failed("The Java engine doesn't have an open file with the id 7."));
    expect(refusals.view('il')).toEqual(failed("The Java engine doesn't have the view il."));
    expect(refusals.key('app.jar', 99)).toEqual(failed("app.jar doesn't have a symbol with the key 99."));
    expect(refusals.noDocument('draw')).toEqual(failed("draw doesn't have its own document."));
});

test("createRefusals writes the file's name for a file above the limit in MB and for a file that doesn't fit in memory", () => {
    expect(refusals.largeFile('huge.war', 512 * 1024 * 1024)).toEqual(failed("huge.war has more than 512 MB, which the engine can't open."));
    expect(refusals.outOfMemory('app.war')).toEqual(failed("app.war doesn't fit in the engine's memory."));
});

test('findDocumentRowReply returns the row of a key with its own document in a view of the engine', () => {
    expect(findDocumentRowReply({ name: 'app.jar', rows }, 0, 'java', ['java'], refusals)).toEqual({ value: rows[0] });
});

test("findDocumentRowReply refuses a view that the engine doesn't have, a missing key and a row without its own document", () => {
    const file = { name: 'app.jar', rows };

    expect(findDocumentRowReply(file, 0, 'il', ['java'], refusals)).toEqual(refusals.view('il'));
    expect(findDocumentRowReply(file, 99, 'java', ['java'], refusals)).toEqual(refusals.key('app.jar', 99));
    expect(findDocumentRowReply(file, 1, 'java', ['java'], refusals)).toEqual(refusals.noDocument('draw'));
});
