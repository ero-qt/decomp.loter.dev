import { expect, setDefaultTimeout, test } from 'bun:test';
import {
    checkBrokenFile,
    checkCanceledRead,
    checkClaims,
    checkClosedFile,
    checkCompanion,
    checkLinkedFile,
    checkManifest,
    checkReferences,
    checkRows,
    checkStringLimits,
    checkStrings,
    listChecks,
    testEngine,
} from './conformance';
import {
    type AnyCheck,
    type BreakHandlers,
    changeListings,
    changeRows,
    changeTarget,
    emptyDescription,
    fixture,
    type FullFixture,
    functionsFixture,
    listCalls,
    testFailure,
    useBrokenHandlers,
} from './conformance-testing';
import { parseTarget, writeTokens } from './document';
import { fakeManifest } from './fake';
import { areaOutside, useFakeEngine } from './fake-testing';
import { failed, ok } from './reply';
import { findDocumentRow, readRows, type Row } from './rows';

const connect = useFakeEngine();

function claimAs(claimedName: string, isClaimed: boolean): BreakHandlers {
    return ({ claims }) => ({
        claims(name, file, signal) {
            return name === claimedName ? ok(isClaimed) : claims(name, file, signal);
        },
    });
}

// moves each place to the first line with the place's offset in the text as its character
function placeOnFirstLine(text: string, ranges: Int32Array): number[] {
    const lineStarts = [0, ...[...text.matchAll(/\n/g)].map(match => match.index + 1)];

    return [...ranges].flatMap((value, index) => {
        return index % 3 === 0 ? [0] : index % 3 === 1 ? [lineStarts[ranges[index - 1]] + value] : [value];
    });
}

function giveSameKey(rows: Row[]) {
    rows[2].key = rows[1].key;
}

// registers the tests under a default time limit of 1 ms because the tests then only pass with testEngine's time limit
setDefaultTimeout(1);
testEngine('fake engine', connect, fixture, 1000);
setDefaultTimeout(5000);

testEngine('fake engine with a file of functions', connect, functionsFixture);

const baseClaims = [
    'has a manifest that readManifest accepts',
    'claims only the files that the engine opens',
    'refuses a broken file with an engine error',
    'lists rows that readRows accepts, each with a key of its own',
    'writes documents that declare their rows and locals and point each row target at 1 row',
    'lists strings whose users are rows',
    'lists at most 50,000 strings, each with at most 1,000 characters',
    'refuses the calls for a closed file',
    'writes a document again after a canceled read of the document',
];

test('listChecks lists the checks of every engine and of both groups of the fixture', () => {
    expect(listChecks(fixture).map(([claim]) => claim)).toEqual([
        ...baseClaims,
        "resolves a symbol outside the open files to a row once the symbol's file is open",
        "finds a symbol's user in another file",
        'lists a companion as a missing file until provide gets the companion',
    ]);
});

test('listChecks lists only the checks of every engine for a fixture without a group', () => {
    expect(listChecks(functionsFixture).map(([claim]) => claim)).toEqual(baseClaims);
});

const defects: [defect: string, breakHandlers: BreakHandlers, check: AnyCheck, message: string][] = [
    [
        "a file that the engine opens and doesn't claim",
        claimAs('drawing.fake', false),
        checkClaims,
        "the engine doesn't claim drawing.fake",
    ],
    [
        "a linked file that the engine doesn't claim",
        claimAs('shapes.fake', false),
        checkClaims,
        "the engine doesn't claim shapes.fake",
    ],
    [
        'a file of another kind that the engine claims',
        () => ({ claims: () => ok(true) }),
        checkClaims,
        'the engine claims shapes.dll',
    ],
    [
        'a companion that the engine claims',
        claimAs('drawing.notes', true),
        checkClaims,
        'the engine claims drawing.notes',
    ],
    [
        'a broken file that opens',
        () => ({ open: () => ok(undefined) }),
        checkBrokenFile,
        "open doesn't throw an engine error for broken.fake",
    ],
    [
        'a broken file that crashes the engine',
        () => ({
            open() {
                throw new Error('Maximum call stack size exceeded.');
            },
        }),
        checkBrokenFile,
        "open doesn't throw an engine error for broken.fake",
    ],
    [
        'a row whose parent is a later row',
        changeRows(rows => {
            rows[0].parent = 3;
        }),
        checkRows,
        "row 0 has the parent 3, which isn't an earlier row",
    ],
    [
        '2 rows with the same key',
        changeRows(giveSameKey),
        checkRows,
        '2 rows of drawing.fake have the key 2',
    ],
    [
        'a read that fails after a canceled read',
        ({ read }) => {
            let wasCanceled = false;

            return {
                read(fileId, key, view, signal) {
                    signal.addEventListener('abort', () => (wasCanceled = true));

                    return wasCanceled ? failed('The engine lost its state.') : read(fileId, key, view, signal);
                },
            };
        },
        checkCanceledRead,
        "the engine doesn't write the document of Drawing.Circle in the view code after a canceled read",
    ],
    [
        "a string whose user isn't a target",
        () => ({ listStrings: () => ok([{ text: 'circle', user: 'Draw' }]) }),
        checkStrings,
        "the reply of listStrings isn't a list of texts, each with a row target or null as its user",
    ],
    [
        'a string whose user is a local',
        () => ({ listStrings: () => ok([{ text: 'circle', user: 'L:0' }]) }),
        checkStrings,
        "the reply of listStrings isn't a list of texts, each with a row target or null as its user",
    ],
    [
        'a string longer than the limit',
        () => ({ listStrings: () => ok([{ text: 'x'.repeat(1001), user: null }]) }),
        checkStringLimits,
        'drawing.fake has a string of 1001 characters, more than 1000',
    ],
    [
        'more strings than the limit',
        () => ({ listStrings: () => ok(Array.from({ length: 50001 }, () => ({ text: 'x', user: null }))) }),
        checkStringLimits,
        'drawing.fake lists 50001 strings, more than 50000',
    ],
    [
        'a close that leaves the file open',
        () => ({ close: () => ok(undefined) }),
        checkClosedFile,
        "list doesn't throw an engine error for a closed file",
    ],
    [
        'a document of a closed file',
        () => ({ read: () => ok(writeTokens('', [], [])) }),
        checkClosedFile,
        "read doesn't throw an engine error for a closed file",
    ],
    [
        'strings of a closed file',
        () => ({ listStrings: () => ok([]) }),
        checkClosedFile,
        "listStrings doesn't throw an engine error for a closed file",
    ],
    [
        'a closed file that takes a companion',
        () => ({ provide: () => ok(undefined) }),
        checkClosedFile,
        "provide doesn't throw an engine error for a closed file",
    ],
    [
        'a close that closes every file',
        ({ close }) => ({
            async close(_, signal) {
                await close(1, signal);

                return close(2, signal);
            },
        }),
        checkClosedFile,
        "The fake engine doesn't have an open file with the id 1.",
    ],
    [
        'a row target for a symbol of a closed file',
        handlers => ({ ...changeTarget(areaOutside, '1:2')(handlers), resolve: () => ok(null) }),
        checkLinkedFile,
        "the target 1:2 isn't outside the open files while shapes.fake is closed",
    ],
    [
        'a symbol of a closed file that resolves to a row',
        () => ({ resolve: () => ok('1:2') }),
        checkLinkedFile,
        `the target ${areaOutside} isn't outside the open files while shapes.fake is closed`,
    ],
    [
        'a description without the missing file of a symbol outside the open files',
        () => ({ describe: () => ok(emptyDescription) }),
        checkLinkedFile,
        `the description of ${areaOutside} has the missing file null and not shapes.fake`,
    ],
    [
        'a file that lists no missing file for the linked file',
        changeListings(listing => {
            listing.missingFiles = [];
        }),
        checkLinkedFile,
        "drawing.fake doesn't list shapes.fake as a missing file",
    ],
    [
        'a linked file that is listed as a missing companion',
        changeListings(listing => {
            listing.missingFiles = listing.missingFiles.map(missingFile => ({ ...missingFile, isCompanion: true }));
        }),
        checkLinkedFile,
        'the missing file shapes.fake is a companion',
    ],
    [
        'a symbol that stays outside after its file is open',
        () => ({ resolve: () => ok(null) }),
        checkLinkedFile,
        `the target ${areaOutside} doesn't resolve to a row while shapes.fake is open`,
    ],
    [
        'a token that points at another row than the resolved row',
        ({ resolve }) => ({
            async resolve(target, signal) {
                const reply = await resolve(target, signal);

                return reply.value ? ok('2:2') : reply;
            },
        }),
        checkLinkedFile,
        "the token 'Shapes.Shape.Area' has the target 2:3 and not 2:2 while shapes.fake is open",
    ],
    [
        "a row target that doesn't resolve to the same target",
        ({ resolve }) => ({
            resolve(target, signal) {
                return target.startsWith('|') ? resolve(target, signal) : ok(null);
            },
        }),
        checkLinkedFile,
        "the row target 2:3 doesn't resolve to the same target",
    ],
    [
        "a resolved target that doesn't point at a row",
        changeRows((rows, fileId) => {
            rows[2].key += fileId === 2 ? 96 : 0;
        }),
        checkLinkedFile,
        'the target 2:3 points at 0 rows',
    ],
    [
        'a missing file that stays after the linked file is open',
        changeListings(listing => {
            listing.missingFiles.push({ name: 'shapes.fake', reason: 'not loaded', isCompanion: false });
        }),
        checkLinkedFile,
        'drawing.fake still lists shapes.fake as a missing file',
    ],
    [
        'a missing reference',
        () => ({ findReferences: () => ok([]) }),
        checkReferences,
        "the users of 2:3 in the view code don't include 1:5, the target of Drawing.Circle.Draw",
    ],
    [
        'a missing reference for a symbol outside the open files',
        ({ findReferences }) => ({
            findReferences(target, view, signal) {
                return target.startsWith('|') ? ok([]) : findReferences(target, view, signal);
            },
        }),
        checkReferences,
        `the users of ${areaOutside} in the view code don't include 1:5, the target of Drawing.Circle.Draw`,
    ],
    [
        'a user that is a local',
        () => ({ findReferences: () => ok([{ user: '1:5', ranges: null }, { user: 'L:0', ranges: null }]) }),
        checkReferences,
        "the reply of findReferences isn't a list of row targets, each with ranges or null",
    ],
    [
        'a place without a use',
        ({ findReferences }) => ({
            async findReferences(target, view, signal) {
                const reply = await findReferences(target, view, signal);

                return ok(reply.value!.map(({ user, ranges }) => ({ user, ranges: ranges && new Int32Array([5, 13, 17]) })));
            },
        }),
        checkReferences,
        "the document of Circle in the view ops doesn't have a use of 2:3 at line 5, character 13 with the length 17",
    ],
    [
        'places with the offset in the document as the character',
        ({ findReferences, list, read }) => ({
            async findReferences(target, view, signal) {
                const reply = await findReferences(target, view, signal);
                if (!reply.value) {
                    return reply;
                }

                const references = reply.value.map(async ({ user, ranges }) => {
                    const { fileId, key } = parseTarget(user) as { fileId: number; key: number };
                    const rows = readRows((await list(fileId, signal)).value!);
                    const documentRow = rows[findDocumentRow(rows, rows.findIndex(row => row.key === key))!];
                    const { text } = (await read(fileId, documentRow.key, view, signal)).value!;

                    return { user, ranges: ranges && new Int32Array(placeOnFirstLine(text, ranges)) };
                });

                return ok(await Promise.all(references));
            },
        }),
        checkReferences,
        "the document of Circle in the view ops doesn't have a use of 2:3 at line 0, character",
    ],
    [
        "references in a view that the manifest doesn't have",
        ({ findReferences }) => ({
            findReferences(target, _, signal) {
                return findReferences(target, 'code', signal);
            },
        }),
        checkReferences,
        "findReferences doesn't throw an engine error for a view that the manifest doesn't have",
    ],
    [
        'a file that lists no missing file for the companion',
        changeListings(listing => {
            listing.missingFiles = [];
        }),
        checkCompanion,
        "drawing.fake doesn't list drawing.notes as a missing file",
    ],
    [
        "a companion that is listed as a missing file that isn't a companion",
        changeListings(listing => {
            listing.missingFiles = listing.missingFiles.map(missingFile => ({ ...missingFile, isCompanion: false }));
        }),
        checkCompanion,
        "the missing file drawing.notes isn't a companion",
    ],
    [
        'a missing file that stays after its file is provided',
        () => ({ provide: () => ok(undefined) }),
        checkCompanion,
        'drawing.fake still lists drawing.notes as a missing file',
    ],
];

const misfits: [claim: string, misfit: FullFixture, check: AnyCheck, message: string][] = [
    [
        'a manifest without a view',
        { ...fixture, manifest: { ...fakeManifest, views: [] } },
        checkManifest,
        "the manifest doesn't have a view",
    ],
    [
        "a linked fixture whose manifest doesn't have hasLinkedFiles",
        { ...fixture, manifest: { ...fakeManifest, hasLinkedFiles: false } },
        checkManifest,
        "the fixture has a linked file and the manifest doesn't have hasLinkedFiles",
    ],
    [
        'a file whose name has no extension of the manifest',
        { ...fixture, manifest: { ...fakeManifest, extensions: ['.other'] } },
        checkClaims,
        "the page doesn't ask the engine about drawing.fake, which matches no extension and no magic of the manifest",
    ],
    [
        "a string that the file doesn't have",
        { ...fixture, string: 'square' },
        checkStrings,
        "drawing.fake doesn't have the string 'square'",
    ],
    [
        "a long string that the file doesn't list cut",
        { ...fixture, cutString: 'circle' },
        checkStringLimits,
        "drawing.fake doesn't list a string that starts with 'circle' and ends with the cut mark …",
    ],
    [
        "a token that the symbol's document doesn't have",
        { ...fixture, linked: { ...fixture.linked, token: 'Shapes.Shape' } },
        checkLinkedFile,
        "the document of Drawing.Circle doesn't have a token 'Shapes.Shape' with a target",
    ],
    [
        "a user whose code doesn't use the token's symbol",
        { ...fixture, linked: { ...fixture.linked, user: 'Drawing.Circle.Circle' } },
        checkReferences,
        "the users of 2:3 in the view code don't include 1:4, the target of Drawing.Circle.Circle",
    ],
];

for (const [defect, breakHandlers, check, message] of defects) {
    testFailure(defect, breakHandlers, check, message);
}

for (const [claim, misfit, check, message] of misfits) {
    testFailure(claim, () => ({}), check, message, misfit);
}

test("check fails for a manifest with hasLinkedFiles and a fixture that doesn't have a linked file", async () => {
    const misfit = { ...functionsFixture, manifest: fakeManifest };

    await expect(checkManifest(connect(), misfit)).rejects.toThrow("the manifest has hasLinkedFiles and the fixture doesn't have a linked file");
});

test('check closes a broken file that opens', async () => {
    useBrokenHandlers(() => ({ open: () => ok(undefined) }));

    await expect(checkBrokenFile(connect(), fixture)).rejects.toThrow();
    expect(listCalls()).toContainEqual(['close', 1]);
});

test('check closes every file and throws the first error after a close that fails', async () => {
    useBrokenHandlers(({ close }) => ({
        close(fileId, signal) {
            return fileId === 1 ? failed('The engine is stuck.') : close(fileId, signal);
        },
        findReferences: () => ok([]),
    }));

    await expect(checkReferences(connect(), fixture)).rejects.toThrow("the users of 2:3 in the view code don't include 1:5");
    expect(listCalls()).toContainEqual(['close', 2]);
    await expect(checkRows(connect(), fixture)).rejects.toThrow('The engine is stuck.');
});

test('check takes the first token with the text that has a target', async () => {
    const [code, ops] = fakeManifest.views;
    const file = new File(['fake\nmethod Draw\n uses words.fake|uses'], 'drawing.fake');
    const linked = { file: new File(['fake\nmethod uses'], 'words.fake'), token: 'uses', user: 'Draw' };

    await checkLinkedFile(connect(), { ...fixture, manifest: { ...fakeManifest, views: [ops, code] }, file, symbol: 'Draw', linked });
});
