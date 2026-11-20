import { afterEach, beforeEach } from 'bun:test';
import type { Engine } from './engine';
import { createFakeHandlers } from './fake';
import { restoreWorker, useInThreadWorker } from './in-thread-worker';
import { connectEngine } from './queue';

/** The target of `Shapes.Shape.Area` in the sample files while `shapes.fake` is closed. */
export const areaOutside = '|shapes.fake|Shapes.Shape.Area';

/** Connects a test to the engine in the in-thread worker that the test serves. */
export function connectFake(): Engine {
    return connectEngine('fake.js', { timeLimitMs: 1000, cancelLimitMs: 100, hasLinkedFiles: true });
}

/**
 * Serves the fake engine in an in-thread worker during each test of a file and returns the function that connects a
 * test.
 */
export function useFakeEngine(): () => Engine {
    beforeEach(() => useInThreadWorker(createFakeHandlers));
    afterEach(restoreWorker);

    return connectFake;
}
