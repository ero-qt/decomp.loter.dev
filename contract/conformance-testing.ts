import { expect, test } from 'bun:test';
import type { Check, Fixture } from './conformance';
import type { Document } from './document';
import type { Listing } from './engine';
import { createFakeHandlers, fakeManifest, sampleFiles } from './fake';
import { connectFake } from './fake-testing';
import { InThreadWorker, useInThreadWorker } from './in-thread-worker';
import { ok } from './reply';
import { readRows, type Row, writeRows } from './rows';
import type { EngineHandlers } from './serve';

/** Returns the handlers that replace the fake engine's handlers, from the fake engine's handlers. */
export type BreakHandlers = (handlers: EngineHandlers) => Partial<EngineHandlers>;

/** A check of any group. */
export type AnyCheck = Check<'linked' | 'companion'>;

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
export function testFailure(defect: string, breakHandlers: BreakHandlers, check: AnyCheck, message: string, checked = fixture) {
    test(`check fails for ${defect}`, async () => {
        useBrokenHandlers(breakHandlers);

        await expect(check(connectFake(), checked)).rejects.toThrow(message);
    });
}
