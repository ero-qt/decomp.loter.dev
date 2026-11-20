import { test } from 'bun:test';
import {
    type Check,
    checkedRowLimit,
    checkWithFiles,
    type Fixture,
    type FixtureWith,
    findRow,
    type Group,
    missingView,
    type OpenRows,
    readFirstView,
    requireEngineError,
    requireRowTarget,
} from './checking';
import { formatTarget, parseTarget, readTokens } from './document';
import { checkDocuments } from './document-checks';
import type { Description, Engine, MissingFile, Reference } from './engine';
import { matchesFile, readManifest, readStart } from './manifest';
import { findDocumentRow, readRows, type Row } from './rows';

export type { Check, Fixture, FixtureWith } from './checking';
export { checkDocuments } from './document-checks';

async function hasMissingFile(engine: Engine, fileId: number, name: string): Promise<boolean> {
    return (await engine.list(fileId)).missingFiles.some(missingFile => missingFile.name === name);
}

async function readTokenTarget(engine: Engine, fixture: FixtureWith<'linked'>, fileId: number, rows: Row[]): Promise<string> {
    const { file, symbol, linked } = fixture;
    const document = await engine.read(fileId, findRow(rows, symbol, file.name).key, readFirstView(fixture));
    const token = readTokens(document).find(({ start, length, target }) => {
        return target !== null && document.text.slice(start, start + length) === linked.token;
    });
    if (!token?.target) {
        throw new Error(`the document of ${symbol} doesn't have a token '${linked.token}' with a target`);
    }

    return token.target;
}

/**
 * Checks that `readManifest` accepts the manifest and that the manifest has `hasLinkedFiles` exactly when the fixture
 * has a linked file.
 */
export async function checkManifest(_: Engine, { manifest, linked }: Fixture): Promise<void> {
    const hasLinkedFiles = readManifest(manifest).hasLinkedFiles === true;
    if (hasLinkedFiles && !linked) {
        throw new Error("the manifest has hasLinkedFiles and the fixture doesn't have a linked file");
    }
    if (!hasLinkedFiles && linked) {
        throw new Error("the fixture has a linked file and the manifest doesn't have hasLinkedFiles");
    }
}

/**
 * Checks that the file and the linked file each match an extension or a magic of the manifest, that the engine claims
 * both and that the engine claims neither the foreign file nor the companion.
 */
export async function checkClaims(engine: Engine, { manifest, file, linked, foreign, companion }: Fixture): Promise<void> {
    const read = readManifest(manifest);
    for (const claimed of [file, linked?.file]) {
        if (claimed && !matchesFile(read, claimed.name, await readStart(claimed))) {
            throw new Error(`the page doesn't ask the engine about ${claimed.name}, which matches no extension and no magic of the manifest`);
        }
        if (claimed && !(await engine.claims(claimed.name, claimed))) {
            throw new Error(`the engine doesn't claim ${claimed.name}`);
        }
    }

    for (const other of [foreign, companion?.file]) {
        if (other && (await engine.claims(other.name, other))) {
            throw new Error(`the engine claims ${other.name}`);
        }
    }
}

/** Checks that `open` throws an engine error for the broken file. */
export async function checkBrokenFile(engine: Engine, { broken }: Fixture): Promise<void> {
    function refuseOpenFile(): Promise<void> {
        return Promise.reject(new Error(`${broken.name} is open`));
    }

    await requireEngineError(checkWithFiles(engine, [broken], refuseOpenFile), 'open', broken.name);
}

/** Checks that `readRows` accepts the file's rows and that each row has a key of its own. */
export async function checkRows(engine: Engine, { file }: Fixture): Promise<void> {
    await checkWithFiles(engine, [file], async fileId => {
        const keys = new Set<number>();
        for (const { key } of readRows(await engine.list(fileId))) {
            if (keys.has(key)) {
                throw new Error(`2 rows of ${file.name} have the key ${key}`);
            }

            keys.add(key);
        }
    });
}

/**
 * Checks that the file's strings include the fixture's string and that each of the strings' first 50 users is a row.
 */
export async function checkStrings(engine: Engine, fixture: Fixture): Promise<void> {
    const { file, string } = fixture;
    await checkWithFiles(engine, [file], async fileId => {
        const strings = await engine.listStrings(fileId);
        const openRows: OpenRows = new Map([[fileId, readRows(await engine.list(fileId))]]);
        if (string !== undefined && !strings.some(({ text }) => text === string)) {
            throw new Error(`${file.name} doesn't have the string '${string}'`);
        }

        for (const user of [...new Set(strings.map(listed => listed.user))].slice(0, checkedRowLimit)) {
            if (user !== null) {
                await requireRowTarget(engine, openRows, user, readFirstView(fixture));
            }
        }
    });
}

/** Checks that the calls for a closed file throw an engine error while a call for another open file works. */
export async function checkClosedFile(engine: Engine, fixture: Fixture): Promise<void> {
    const { file, symbol } = fixture;
    await checkWithFiles(engine, [file], async openId => {
        const closedId = await engine.open(file.name, file);
        const { key } = findRow(readRows(await engine.list(closedId)), symbol, file.name);
        await engine.close(closedId);

        await requireEngineError(engine.list(closedId), 'list', 'a closed file');
        await requireEngineError(engine.read(closedId, key, readFirstView(fixture)), 'read', 'a closed file');
        await requireEngineError(engine.listStrings(closedId), 'listStrings', 'a closed file');
        await requireEngineError(engine.provide(closedId, file.name, file), 'provide', 'a closed file');
        await engine.list(openId);
    });
}

// checks that the description and a missing file that isn't a companion have the linked file's name, or for a fixture
// `withoutMissingFile` that neither has a missing file
function requireMissingFile({ file, linked }: FixtureWith<'linked'>, outside: string, description: Description | null, missingFiles: MissingFile[]) {
    const { name } = linked.file;
    const missingFile = missingFiles.find(missingFile => missingFile.name === name);
    if (linked.withoutMissingFile) {
        if (!description) {
            throw new Error(`the engine doesn't describe ${outside}`);
        }
        if (description.missingFile !== null) {
            throw new Error(`the description of ${outside} has the missing file ${description.missingFile} and not null`);
        }
        if (missingFile) {
            throw new Error(`${file.name} lists ${name} as a missing file, though the fixture's linked file has withoutMissingFile`);
        }

        return;
    }
    if (description?.missingFile !== name) {
        throw new Error(`the description of ${outside} has the missing file ${description?.missingFile ?? null} and not ${name}`);
    }
    if (!missingFile) {
        throw new Error(`${file.name} doesn't list ${name} as a missing file`);
    }
    if (missingFile.isCompanion) {
        throw new Error(`the missing file ${name} is a companion`);
    }
}

/**
 * Checks that the token's symbol is outside the open files while the linked file is closed and that the symbol's
 * description and a missing file of the file that isn't a companion have the linked file's name, or for a fixture
 * `withoutMissingFile` that the engine describes the symbol and neither lists the linked file as a missing file. Checks
 * that the symbol resolves to a row once the linked file is open, that the row's target resolves to the same target,
 * that the token then points at the row and that the file doesn't list the linked file as a missing file.
 */
export async function checkLinkedFile(engine: Engine, fixture: FixtureWith<'linked'>): Promise<void> {
    const { file, linked } = fixture;
    const { name } = linked.file;
    const view = readFirstView(fixture);
    await checkWithFiles(engine, [file], async fileId => {
        const listing = await engine.list(fileId);
        const rows = readRows(listing);
        const outside = await readTokenTarget(engine, fixture, fileId, rows);
        const description = await engine.describe(outside, view);
        if (!('outside' in parseTarget(outside)) || (await engine.resolve(outside)) !== null) {
            throw new Error(`the target ${outside} isn't outside the open files while ${name} is closed`);
        }
        requireMissingFile(fixture, outside, description, listing.missingFiles);

        await checkWithFiles(engine, [linked.file], async linkedId => {
            const resolved = await engine.resolve(outside);
            const target = await readTokenTarget(engine, fixture, fileId, rows);
            if (resolved === null) {
                throw new Error(`the target ${outside} doesn't resolve to a row while ${name} is open`);
            }
            if ((await engine.resolve(resolved)) !== resolved) {
                throw new Error(`the row target ${resolved} doesn't resolve to the same target`);
            }
            if (target !== resolved) {
                throw new Error(`the token '${linked.token}' has the target ${target} and not ${resolved} while ${name} is open`);
            }

            await requireRowTarget(engine, new Map([[linkedId, readRows(await engine.list(linkedId))]]), resolved, view);
            if (await hasMissingFile(engine, fileId, name)) {
                throw new Error(`${file.name} still lists ${name} as a missing file`);
            }
        });
    });
}

// returns `undefined` for a place that doesn't fit in its line because the offset would otherwise point into a later
// line
function findOffset(lines: string[], line: number, character: number, length: number): number | undefined {
    if (line >= lines.length || character >= lines[line].length || character + length > lines[line].length) {
        return undefined;
    }

    return lines.slice(0, line).reduce((offset, skipped) => offset + skipped.length + 1, character);
}

/**
 * Throws unless the document of the user's document row has a token with one of the targets at each of the user's
 * places.
 */
async function requirePlaces(engine: Engine, openRows: OpenRows, targets: string[], { user, ranges }: Reference, view: string) {
    // casts the target because `requireRowTarget` already checked that the user is a row target of an open row
    const { fileId, key } = parseTarget(user) as { fileId: number; key: number };
    const rows = openRows.get(fileId)!;
    const documentRow = rows[findDocumentRow(rows, rows.findIndex(row => row.key === key)) ?? -1];
    if (!ranges || !documentRow) {
        return;
    }

    const document = await engine.read(fileId, documentRow.key, view);
    const tokens = readTokens(document);
    // leaves out the empty part after the text's last line end, which `readTokens` requires
    const lines = document.text.split('\n').slice(0, -1);
    for (let index = 0; index < ranges.length; index += 3) {
        const [line, character, length] = ranges.subarray(index, index + 3);
        const start = findOffset(lines, line, character, length);
        if (!tokens.some(token => token.start === start && token.length === length && targets.includes(token.target ?? ''))) {
            const place = `line ${line}, character ${character} with the length ${length}`;
            throw new Error(`the document of ${documentRow.name} in the view ${view} doesn't have a use of ${targets[0]} at ${place}`);
        }
    }
}

async function requireUser(engine: Engine, openRows: OpenRows, target: string, user: string, fixture: FixtureWith<'linked'>) {
    const { views } = readManifest(fixture.manifest);
    const targets = [target, (await engine.resolve(target)) ?? target];
    for (const { id: view } of views) {
        const references = await engine.findReferences(target, view);
        if (!references.some(reference => reference.user === user)) {
            throw new Error(`the users of ${target} in the view ${view} don't include ${user}, the target of ${fixture.linked.user}`);
        }

        for (const reference of references.slice(0, checkedRowLimit)) {
            await requireRowTarget(engine, openRows, reference.user, view);
            await requirePlaces(engine, openRows, targets, reference, view);
        }
    }

    await requireEngineError(engine.findReferences(target, missingView), 'findReferences', "a view that the manifest doesn't have");
}

/**
 * Checks in each view that the users of the token's symbol include the fixture's user, which is in another file than
 * the symbol, that each of the first 50 users is a row whose document has a use at each of the user's places and that
 * `findReferences` refuses a view that the manifest doesn't have, once with the symbol's row target while the linked
 * file is open and once with the target outside the open files after the linked file closes.
 */
export async function checkReferences(engine: Engine, fixture: FixtureWith<'linked'>): Promise<void> {
    const { file, linked } = fixture;
    await checkWithFiles(engine, [file], async fileId => {
        const rows = readRows(await engine.list(fileId));
        const openRows: OpenRows = new Map([[fileId, rows]]);
        const user = formatTarget({ fileId, key: findRow(rows, linked.user, file.name).key });
        await checkWithFiles(engine, [linked.file], async linkedId => {
            const linkedRows: OpenRows = new Map([...openRows, [linkedId, readRows(await engine.list(linkedId))]]);
            await requireUser(engine, linkedRows, await readTokenTarget(engine, fixture, fileId, rows), user, fixture);
        });

        await requireUser(engine, openRows, await readTokenTarget(engine, fixture, fileId, rows), user, fixture);
    });
}

/** Checks that the file lists the companion as a missing companion file until `provide` gets the companion. */
export async function checkCompanion(engine: Engine, { file, companion }: FixtureWith<'companion'>): Promise<void> {
    const { name } = companion.file;
    await checkWithFiles(engine, [file], async fileId => {
        const missingFile = (await engine.list(fileId)).missingFiles.find(missingFile => missingFile.name === name);
        if (!missingFile) {
            throw new Error(`${file.name} doesn't list ${name} as a missing file`);
        }
        if (!missingFile.isCompanion) {
            throw new Error(`the missing file ${name} isn't a companion`);
        }

        await engine.provide(fileId, name, companion.file);
        if (await hasMissingFile(engine, fileId, name)) {
            throw new Error(`${file.name} still lists ${name} as a missing file`);
        }
    });
}

/** Checks that the engine writes the symbol's document again after the page cancels a read of the document at once. */
export async function checkCanceledRead(engine: Engine, fixture: Fixture): Promise<void> {
    const { file, symbol } = fixture;
    const view = readFirstView(fixture);
    await checkWithFiles(engine, [file], async fileId => {
        const { key } = findRow(readRows(await engine.list(fileId)), symbol, file.name);
        const written = await engine.read(fileId, key, view);
        const controller = new AbortController();
        const canceled = engine.read(fileId, key, view, controller.signal).catch(() => undefined);
        controller.abort();
        await canceled;

        const again = await engine.read(fileId, key, view).catch(() => undefined);
        if (!again) {
            throw new Error(`the engine doesn't write the document of ${symbol} in the view ${view} after a canceled read`);
        }
        if (again.text !== written.text || again.tokens.join() !== written.tokens.join()) {
            throw new Error(`the document of ${symbol} in the view ${view} changes after a canceled read`);
        }
    });
}

const checks: [claim: string, check: Check][] = [
    ['has a manifest that readManifest accepts', checkManifest],
    ['claims only the files that the engine opens', checkClaims],
    ['refuses a broken file with an engine error', checkBrokenFile],
    ['lists rows that readRows accepts, each with a key of its own', checkRows],
    ['writes documents that declare their rows and locals and point each row target at 1 row', checkDocuments],
    ['lists strings whose users are rows', checkStrings],
    ['refuses the calls for a closed file', checkClosedFile],
    ['writes a document again after a canceled read of the document', checkCanceledRead],
];

const linkedChecks: [claim: string, check: Check<'linked'>][] = [
    ["resolves a symbol outside the open files to a row once the symbol's file is open", checkLinkedFile],
    ["finds a symbol's user in another file", checkReferences],
];

const companionChecks: [claim: string, check: Check<'companion'>][] = [
    ['lists a companion as a missing file until provide gets the companion', checkCompanion],
];

/** Lists the claim and the run of each check that every engine passes and of each check of the fixture's groups. */
export function listChecks(fixture: Fixture): [claim: string, run: (engine: Engine) => Promise<void>][] {
    const { linked, companion } = fixture;

    function bind<Needed extends Group>(groupChecks: [claim: string, check: Check<Needed>][], groupFixture: FixtureWith<Needed>) {
        return groupChecks.map(([claim, check]): [string, (engine: Engine) => Promise<void>] => {
            return [claim, engine => check(engine, groupFixture)];
        });
    }

    return [
        ...bind(checks, fixture),
        ...(linked ? bind(linkedChecks, { ...fixture, linked }) : []),
        ...(companion ? bind(companionChecks, { ...fixture, companion }) : []),
    ];
}

/**
 * Registers a test for each check of `listChecks`. Each test gets a new engine from `connect`, which returns an engine
 * of `connectEngine` so the checks also run the reply checks of `readReplyValue`. A time limit in milliseconds replaces
 * the test runner's time limit for each test.
 */
export function testEngine(name: string, connect: () => Engine, fixture: Fixture, timeLimitMs?: number): void {
    for (const [claim, run] of listChecks(fixture)) {
        test(`${name} ${claim}`, () => run(connect()), timeLimitMs);
    }
}
