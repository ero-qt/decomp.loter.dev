import { expect, test } from 'bun:test';
import { InThreadWorker, restoreWorker } from './in-thread-worker';

test("in-thread worker throws for a test that didn't call useInThreadWorker", () => {
    restoreWorker();

    expect(() => new InThreadWorker()).toThrow("the in-thread worker doesn't have handlers because the test didn't call useInThreadWorker");
});
