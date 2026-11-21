import { expect, test } from 'bun:test';
import { checkWithFiles, findRow, readFirstView } from './checking';
import type { Check, Fixture, FixtureWith } from './conformance';
import type { Document } from './document';
import type { Engine, Listing } from './engine';
import { createFakeHandlers, fakeManifest, sampleFiles } from './fake';
import { connectFake } from './fake-testing';
import { InThreadWorker, useInThreadWorker } from './in-thread-worker';
import { EngineError, ok } from './reply';
import { readRows, type Row, writeRows } from './rows';
import type { EngineHandlers } from './serve';

/** Returns the handlers that replace the fake engine's handlers, from the fake engine's handlers. */
export type BreakHandlers = (handlers: EngineHandlers) => Partial<EngineHandlers>;

/** A check of any group. */
export type AnyCheck = Check<'linked' | 'companion'>;

/** A fixture with both groups, which every check takes. */
export type FullFixture = FixtureWith<'linked' | 'companion'>;

/** The fixture of the sample files, with both groups. */
export const fixture = {
    manifest: fakeManifest,
    file: sampleFiles.drawing,
    broken: new File(['fake\npublic klass Circle'], 'broken.fake'),
    foreign: new File(['MZ'], 'shapes.dll'),
    symbol: 'Drawing.Circle',
    string: 'circle',
    linked: { file: sampleFiles.shapes, token: 'Shapes.Shape.Area', user: 'Drawing.Circle.Draw' },
    companion: { file: new File(['a note'], 'drawing.notes') },
} satisfies Fixture;

/** A fixture of a file of functions without the groups. */
export const functionsFixture: Fixture = {
    ...fixture,
    manifest: { ...fakeManifest, hasLinkedFiles: false },
    file: new File(['fake\nmethod main\n uses functions.fake|exit\nmethod exit'], 'functions.fake'),
    symbol: 'main',
    string: undefined,
    linked: undefined,
    companion: undefined,
};

/** A description whose fields are all empty or null. */
export const emptyDescription = { text: '', container: null, facts: [], missingFile: null };

/** Serves the fake engine with the handlers that `breakHandlers` replaces in each new worker of the test. */
export function useBrokenHandlers(breakHandlers: BreakHandlers) {
    useInThreadWorker(() => {
        const handlers = createFakeHandlers();

        return { ...handlers, ...breakHandlers(handlers) };
    });
}

/** Lists the method and the first argument of each call that the workers of the test got. */
export function listCalls(): unknown[][] {
    return InThreadWorker.created.flatMap(worker => worker.calls);
}

/** Replaces `list` with a handler that changes each listing of the fake engine. */
export function changeListings(change: (listing: Listing, fileId: number) => void): BreakHandlers {
    return ({ list }) => ({
        async list(fileId, signal) {
            const reply = await list(fileId, signal);
            if (reply.value) {
                change(reply.value, fileId);
            }

            return reply;
        },
    });
}

/**
 * Drops the missing files that aren't companions and the missing file of each description, like an engine that can't
 * find a symbol's file.
 */
export const withoutMissingFiles: BreakHandlers = handlers => ({
    ...changeListings(listing => {
        listing.missingFiles = listing.missingFiles.filter(missingFile => missingFile.isCompanion);
    })(handlers),
    async describe(target, view, signal) {
        const reply = await handlers.describe(target, view, signal);

        return reply.value ? ok({ ...reply.value, missingFile: null }) : reply;
    },
});

/** Replaces `list` with a handler that changes the rows of each listing of the fake engine. */
export function changeRows(change: (rows: Row[], fileId: number) => void): BreakHandlers {
    return changeListings((listing, fileId) => {
        const rows = readRows(listing);
        change(rows, fileId);
        Object.assign(listing, writeRows(rows));
    });
}

/** Replaces `read` with a handler that changes each document of the fake engine. */
export function changeDocuments(change: (document: Document) => void): BreakHandlers {
    return ({ read }) => ({
        async read(...args) {
            const reply = await read(...args);
            if (reply.value) {
                change(reply.value);
            }

            return reply;
        },
    });
}

/** Replaces `read` with a handler that replaces a target in each document of the fake engine. */
export function changeTarget(from: string, to: string): BreakHandlers {
    return changeDocuments(document => {
        document.targets = document.targets.map(target => (target === from ? to : target));
    });
}

/** Registers a test that the check fails with the message for an engine whose handlers `breakHandlers` replaces. */
export function testFailure(defect: string, breakHandlers: BreakHandlers, check: AnyCheck, message: string, checked: FullFixture = fixture) {
    test(`check fails for ${defect}`, async () => {
        useBrokenHandlers(breakHandlers);

        await expect(check(connectFake(), checked)).rejects.toThrow(message);
    });
}

// opens the fixture's file, lists its rows and reads its symbol, which are the calls that can need an engine's lazy
// part
async function useFixtureFile(engine: Engine, fixture: Fixture): Promise<void> {
    const { file, symbol } = fixture;
    await checkWithFiles(engine, [file], async fileId => {
        const { key } = findRow(readRows(await engine.list(fileId)), symbol, file.name);
        await engine.read(fileId, key, readFirstView(fixture));
    });
}

/**
 * Checks that the first call that needs the engine's failing loader throws an engine error and not a crash, and that
 * the calls work once the loader works again.
 */
export async function checkLoadFailure(engine: Engine, fixture: Fixture): Promise<void> {
    const thrown = await useFixtureFile(engine, fixture).then(
        () => undefined,
        (error: unknown) => error ?? null,
    );
    if (thrown === undefined) {
        throw new Error("the engine doesn't throw while its loader fails");
    }
    if (!(thrown instanceof EngineError)) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        throw new Error(`the engine throws '${message}' and not an engine error while its loader fails`);
    }

    await useFixtureFile(engine, fixture);
}

/**
 * Registers a test that an engine whose loader rejects as often as `connect` gets refuses a call with an engine error
 * and loads again with a later call. `connect` serves the engine with such a loader and connects the test.
 */
export function testLoadFailure(name: string, connect: (failures: number) => Engine, fixture: Fixture, timeLimitMs?: number): void {
    test(`${name} refuses a call while its loader fails and loads again with a later call`, () => checkLoadFailure(connect(1), fixture), timeLimitMs);
}
