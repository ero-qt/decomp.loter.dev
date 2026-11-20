import { expect, test } from 'bun:test';
import { checkDocuments } from './conformance';
import {
    type AnyCheck,
    type BreakHandlers,
    changeDocuments,
    changeRows,
    changeTarget,
    emptyDescription,
    fixture,
    functionsFixture,
    listCalls,
    testFailure,
    useBrokenHandlers,
} from './conformance-testing';
import { readTokens, type Token, writeTokens } from './document';
import { pickRows } from './document-checks';
import { fakeManifest } from './fake';
import { areaOutside, useFakeEngine } from './fake-testing';
import { failed, ok } from './reply';
import { type Row, writeRows } from './rows';
import { flagsOf } from './symbols';

const connect = useFakeEngine();

const defects: [defect: string, breakHandlers: BreakHandlers, check: AnyCheck, message: string][] = [
    [
        'a token outside the text',
        changeDocuments(document => {
            const [first, ...tokens] = readTokens(document);
            Object.assign(document, writeTokens(document.text, [{ ...first, length: 1000 }, ...tokens], document.locals));
        }),
        checkDocuments,
        'token 0 covers 20 to 1020 outside a text of',
    ],
    [
        "a target that isn't a target",
        changeTarget(areaOutside, 'Area'),
        checkDocuments,
        "token 6 has the target 'Area', which isn't a target",
    ],
    [
        "a row with the `document` modifier whose document the engine refuses",
        changeRows(rows => {
            rows[2].flags |= flagsOf('', 'document');
        }),
        checkDocuments,
        "radius doesn't have its own document.",
    ],
    [
        'a document with a carriage return',
        changeDocuments(document => {
            document.text = document.text.replace('\n', '\r\n');
        }),
        checkDocuments,
        'the text has a carriage return at 26',
    ],
    [
        'a token that crosses a line end',
        changeDocuments(document => {
            const [first, ...tokens] = readTokens(document);
            Object.assign(document, writeTokens(document.text, [{ ...first, length: 10 }, ...tokens], document.locals));
        }),
        checkDocuments,
        'token 0 crosses the line end at 26',
    ],
    [
        "a document without the declaration of a row below the document's row",
        changeDocuments(document => {
            const tokens = readTokens(document).map(token => (token.target === '1:5' ? { ...token, flags: 0 } : token));
            Object.assign(document, writeTokens(document.text, tokens, document.locals));
        }),
        checkDocuments,
        "the document of Circle in the view code doesn't have a declaration token with the target 1:5",
    ],
    [
        "a document without the declaration of the document's row",
        changeDocuments(document => {
            const tokens = readTokens(document).map(token => ({ ...token, flags: 0 }));
            Object.assign(document, writeTokens(document.text, tokens, document.locals));
        }),
        checkDocuments,
        "the document of Circle in the view code doesn't have a declaration token with the target 1:2",
    ],
    [
        'a document without the declaration of a local',
        changeDocuments(document => {
            const tokens = readTokens(document).map(token => (token.target === 'L:0' ? { ...token, flags: 0 } : token));
            Object.assign(document, writeTokens(document.text, tokens, document.locals));
        }),
        checkDocuments,
        "the document of Circle in the view code doesn't have a declaration token with the target L:0",
    ],
    [
        'a row with a declaration in a view that hides it',
        changeRows(rows => {
            rows[2].hiddenViews = 1;
        }),
        checkDocuments,
        'the document of Circle in the view code has a declaration token with the target 1:3, whose row is hidden in the view',
    ],
    [
        'a document of a row that the view hides',
        changeRows(rows => {
            for (const row of rows.slice(1)) {
                row.hiddenViews = 1;
            }
        }),
        checkDocuments,
        "read doesn't throw an engine error for Circle, which is hidden in the view code",
    ],
    [
        'a row that every view hides',
        changeRows(rows => {
            rows[2].hiddenViews = 3;
        }),
        checkDocuments,
        'the row radius is hidden in every view',
    ],
    [
        "a row hidden in a view that the manifest doesn't have",
        changeRows(rows => {
            rows[2].hiddenViews = 4;
        }),
        checkDocuments,
        "the row radius is hidden in a view that the manifest doesn't have",
    ],
    [
        'a row with a negative hiddenViews',
        changeRows(rows => {
            rows[2].hiddenViews = -1;
        }),
        checkDocuments,
        "the row radius is hidden in a view that the manifest doesn't have",
    ],
    [
        "a description in a view that the manifest doesn't have",
        ({ describe }) => ({
            describe(target, _, signal) {
                return describe(target, 'code', signal);
            },
        }),
        checkDocuments,
        "describe doesn't throw an engine error for a view that the manifest doesn't have",
    ],
    [
        "a target that doesn't point at a row",
        changeTarget(areaOutside, '1:63'),
        checkDocuments,
        'the target 1:63 points at 0 rows',
    ],
    [
        'a target that points at 2 rows',
        changeRows(rows => {
            rows[3].key = rows[2].key;
        }),
        checkDocuments,
        'the target 1:3 points at 2 rows',
    ],
    [
        'a row target without a description',
        () => ({ describe: () => ok(null) }),
        checkDocuments,
        "the engine doesn't describe the target 1:2",
    ],
    [
        'a local that the engine describes',
        ({ describe }) => ({
            describe(target, view, signal) {
                return target.startsWith('L:') ? ok(emptyDescription) : describe(target, view, signal);
            },
        }),
        checkDocuments,
        'the engine describes the local L:0',
    ],
    [
        "a description for a target that doesn't point at a row",
        () => ({ describe: target => ok(target.startsWith('L:') ? null : emptyDescription) }),
        checkDocuments,
        "the engine describes the target 1:0, which doesn't point at a row",
    ],
    [
        "a document for a row that doesn't have the `document` modifier",
        ({ read }) => ({
            read(fileId, key, view, signal) {
                return read(fileId, key === 3 ? 2 : key, view, signal);
            },
        }),
        checkDocuments,
        "read doesn't throw an engine error for radius, which doesn't have its own document",
    ],
    [
        'a document for a key that no row has',
        ({ read }) => ({
            read(fileId, key, view, signal) {
                return key === 0 ? ok(writeTokens('', [], [])) : read(fileId, key, view, signal);
            },
        }),
        checkDocuments,
        "read doesn't throw an engine error for a key that no row has",
    ],
    [
        "a document in a view that the manifest doesn't have",
        ({ read }) => ({
            read(fileId, key, view, signal) {
                return read(fileId, key, view === 'ops' ? view : 'code', signal);
            },
        }),
        checkDocuments,
        "read doesn't throw an engine error for a view that the manifest doesn't have",
    ],
];

const misfits: [claim: string, misfit: typeof fixture, check: AnyCheck, message: string][] = [
    [
        "a symbol that isn't the path of a row",
        { ...fixture, symbol: 'Circle' },
        checkDocuments,
        "drawing.fake doesn't have the row Circle",
    ],
];

for (const [defect, breakHandlers, check, message] of defects) {
    testFailure(defect, breakHandlers, check, message);
}

for (const [claim, misfit, check, message] of misfits) {
    testFailure(claim, () => ({}), check, message, misfit);
}

test('check fails for a row target that resolves to null in an engine without linked files', async () => {
    useBrokenHandlers(() => ({ resolve: () => ok(null) }));

    await expect(checkDocuments(connect(), functionsFixture)).rejects.toThrow("the row target 1:1 doesn't resolve to the same target");
});

testFailure(
    'a document of another row',
    ({ read }) => ({
        read(fileId, _, view, signal) {
            return read(fileId, 1, view, signal);
        },
    }),
    checkDocuments,
    "the document of exit in the view code doesn't have a declaration token with the target 1:2",
    { ...fixture, file: new File(['fake\nmethod main\nmethod exit'], 'functions.fake'), symbol: 'main' },
);

test('pickRows picks the first row of each kind, then rows of documents spread over the file, then other rows spread over the file', () => {
    const method: Row = { kind: 'method', flags: flagsOf('', 'document'), parent: -1, key: 1, name: 'm', detail: '', hiddenViews: 0 };
    const field: Row = { ...method, kind: 'field', flags: 0, parent: 0 };
    const rows = [method, field, ...Array.from({ length: 8 }, () => method), field];

    expect(pickRows(rows, 2)).toEqual([0, 1]);
    expect(pickRows(rows, 4)).toEqual([0, 1, 2, 6]);
    expect(pickRows(rows, 20)).toEqual([...rows.keys()]);
    expect(pickRows([...rows.slice(0, 2), ...Array.from({ length: 8 }, () => field)], 4)).toEqual([0, 1, 2, 6]);
});

test("check fails for a class after 60 namespaces whose document doesn't declare the class", async () => {
    const namespaces = Array.from({ length: 60 }, (_, index) => `namespace N${index}`);
    const file = new File([['fake', 'class Early', ...namespaces, 'class Late'].join('\n')], 'late.fake');
    useBrokenHandlers(changeDocuments(document => {
        if (document.text.startsWith('class Late')) {
            Object.assign(document, writeTokens(document.text, readTokens(document).map(token => ({ ...token, flags: 0 })), document.locals));
        }
    }));

    await expect(checkDocuments(connect(), { ...functionsFixture, file, symbol: 'Early' })).rejects.toThrow(
        "the document of Late in the view code doesn't have a declaration token with the target 1:3e",
    );
});

test('check reads the documents of the symbol and of 50 rows in each view', async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `method function${index}`);
    const file = new File([['fake', ...lines].join('\n')], 'functions.fake');
    await checkDocuments(connect(), { ...functionsFixture, file, symbol: 'function59' });

    // reads 51 documents and 1 key without a row in each of the 2 views, then 1 view outside the manifest
    expect(listCalls().filter(([method]) => method === 'read')).toHaveLength(2 * (51 + 1) + 1);
});

test('check passes for a row that only the second view declares', async () => {
    const file = new File(['fake\nclass Box\n hidden private field backing'], 'box.fake');

    await checkDocuments(connect(), { ...functionsFixture, file, symbol: 'Box' });
});

test('check passes for an engine whose row has the key 0', async () => {
    const main: Token = { start: 0, length: 4, kind: 'method', flags: flagsOf('', 'declaration'), target: '1:0' };
    const row: Row = { kind: 'method', flags: flagsOf('', 'document'), parent: -1, key: 0, name: 'main', detail: '', hiddenViews: 0 };
    const hasView = (view: string) => fakeManifest.views.some(({ id }) => id === view);
    useBrokenHandlers(() => ({
        list: () => ok({ ...writeRows([row]), note: '', missingFiles: [] }),
        read(_, key, view) {
            return key === 0 && hasView(view) ? ok(writeTokens('main\n', [main], [])) : failed("The engine doesn't have the document.");
        },
        describe(target, view) {
            return hasView(view) ? ok(target === '1:0' ? emptyDescription : null) : failed("The engine doesn't have the view.");
        },
        resolve: target => ok(target),
    }));

    await checkDocuments(connect(), functionsFixture);
});
