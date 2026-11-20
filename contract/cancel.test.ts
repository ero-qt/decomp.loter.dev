import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Engine } from './engine';
import { InThreadWorker, restoreWorker, useInThreadWorker } from './in-thread-worker';
import { type ConnectOptions, connectEngine } from './queue';
import { CanceledError, ok } from './reply';
import type { EngineHandlers } from './serve';

const file = new Blob(['a']);
const listing = { values: new Int32Array(), names: [], details: [], note: '', missingFiles: [] };
const document = { text: '', tokens: new Int32Array(), targets: [], locals: [] };
// the functions that finish the reads that the workers run, in the order of the reads
let finishReads: (() => void)[];

// serves handlers that ignore their signal, like an engine whose call runs in wasm, and finish a read only through
// `finishReads`
function createHandlers(): EngineHandlers {
    return {
        claims: () => ok(false),
        open: () => ok(undefined),
        close: () => ok(undefined),
        provide: () => ok(undefined),
        list: () => ok(listing),
        read: () => new Promise(resolve => finishReads.push(() => resolve(ok(document)))),
        describe: () => ok(null),
        resolve: () => ok(null),
        findReferences: () => ok([]),
        listStrings: () => ok([]),
    };
}

function connect(options: Partial<ConnectOptions> = {}): Engine {
    return connectEngine('worker.js', { timeLimitMs: 1000, cancelLimitMs: 1000, ...options });
}

function listReceived(worker = 0): unknown[] {
    return InThreadWorker.created[worker].received.map(request => ('cancel' in request ? 'cancel' : request.method));
}

// returns 'waiting' for a call that is still pending after half the time limit, which would also start a new worker
function settleEarly<Value>(called: Promise<Value>): Promise<Value | 'waiting'> {
    return Promise.race([called, Bun.sleep(500).then(() => 'waiting' as const)]);
}

async function waitForReads(count: number) {
    while (finishReads.length < count) {
        await Bun.sleep(1);
    }
}

beforeEach(() => {
    useInThreadWorker(createHandlers);
    finishReads = [];
});

afterEach(restoreWorker);

test('engine rejects a call whose signal aborted before the call and starts no worker for it', async () => {
    const engine = connect();

    await expect(engine.describe('|T:Shape', 'code', AbortSignal.abort())).rejects.toBeInstanceOf(CanceledError);
    expect(InThreadWorker.created).toEqual([]);
});

test('engine drops a canceled call from the queue before the worker gets it', async () => {
    const engine = connect();
    await engine.open('a.dll', file);
    const read = engine.read(1, 2, 'code');
    const controller = new AbortController();
    const described = engine.describe('1:2', 'code', controller.signal);
    await waitForReads(1);

    controller.abort();
    await expect(described).rejects.toBeInstanceOf(CanceledError);
    finishReads[0]();
    await read;

    expect(await engine.list(1)).toEqual(listing);
    expect(listReceived()).toEqual(['open', 'read', 'list']);
});

test('engine rejects a canceled running call at once and sends cancel to the worker', async () => {
    const engine = connect();
    await engine.open('a.dll', file);
    const controller = new AbortController();
    const read = engine.read(1, 2, 'code', controller.signal);
    await waitForReads(1);

    controller.abort();

    await expect(read).rejects.toBeInstanceOf(CanceledError);
    expect(listReceived()).toEqual(['open', 'read', 'cancel']);
});

test("engine runs the next call after the worker's reply to a canceled call and keeps the canceled call rejected", async () => {
    const engine = connect();
    await engine.open('a.dll', file);
    const controller = new AbortController();
    const read = engine.read(1, 2, 'code', controller.signal).catch((error: unknown) => error);
    await waitForReads(1);
    controller.abort();
    const listed = engine.list(1);
    await Bun.sleep(10);
    const receivedBeforeReply = listReceived();

    finishReads[0]();

    expect(await listed).toEqual(listing);
    expect(await read).toBeInstanceOf(CanceledError);
    expect(receivedBeforeReply).toEqual(['open', 'read', 'cancel']);
});

test('engine sends no cancel for a call whose signal aborts after the call settled', async () => {
    const engine = connect();
    await engine.open('a.dll', file);
    const controller = new AbortController();
    const described = engine.describe('1:2', 'code', controller.signal);
    await described;

    controller.abort();
    await engine.list(1);

    expect(listReceived()).toEqual(['open', 'describe', 'list']);
});

test('engine removes its abort listener from a signal once a call settles, so a signal for many calls keeps none', async () => {
    const engine = connect({ timeLimitMs: 50 });
    await engine.open('a.dll', file);
    const { signal } = new AbortController();
    const listeners = new Set<unknown>();
    const { addEventListener, removeEventListener } = signal;
    signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => {
        listeners.add(args[1]);
        addEventListener.apply(signal, args);
    };
    signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => {
        listeners.delete(args[1]);
        removeEventListener.apply(signal, args);
    };

    await engine.describe('1:2', 'code', signal);
    // lets the read run past the time limit because a call that the worker doesn't finish rejects
    await engine.read(1, 2, 'code', signal).catch(() => undefined);

    expect(listeners.size).toBe(0);
});

test('engine stops the worker of a canceled call that runs past the cancel limit while another call waits', async () => {
    const engine = connect({ cancelLimitMs: 20 });
    await engine.open('a.dll', file);
    const controller = new AbortController();
    const read = engine.read(1, 2, 'code', controller.signal).catch((error: unknown) => error);
    await waitForReads(1);
    const listed = engine.list(1);

    controller.abort();

    expect(await settleEarly(listed)).toEqual(listing);
    expect(await read).toBeInstanceOf(CanceledError);
    expect(InThreadWorker.created[0].isStopped).toBe(true);
    expect(listReceived(1)).toEqual(['open', 'list']);
});

test('engine starts the cancel limit for a call that waits behind a canceled call', async () => {
    const engine = connect({ cancelLimitMs: 20 });
    await engine.open('a.dll', file);
    const controller = new AbortController();
    const read = engine.read(1, 2, 'code', controller.signal).catch((error: unknown) => error);
    await waitForReads(1);
    controller.abort();
    await Bun.sleep(40);

    expect(await settleEarly(engine.list(1))).toEqual(listing);
    expect(await read).toBeInstanceOf(CanceledError);
    expect(listReceived(1)).toEqual(['open', 'list']);
});

test('engine keeps the worker of a canceled call while no call waits', async () => {
    const engine = connect({ cancelLimitMs: 20 });
    await engine.open('a.dll', file);
    const controller = new AbortController();
    const read = engine.read(1, 2, 'code', controller.signal).catch((error: unknown) => error);
    await waitForReads(1);
    controller.abort();
    await Bun.sleep(40);
    finishReads[0]();

    expect(await engine.list(1)).toEqual(listing);
    expect(await read).toBeInstanceOf(CanceledError);
    expect(InThreadWorker.created).toHaveLength(1);
});

test('engine keeps the worker of a canceled call after the waiting call is canceled too', async () => {
    const engine = connect({ cancelLimitMs: 20 });
    await engine.open('a.dll', file);
    const readController = new AbortController();
    const describeController = new AbortController();
    const read = engine.read(1, 2, 'code', readController.signal).catch((error: unknown) => error);
    const described = engine.describe('1:2', 'code', describeController.signal).catch((error: unknown) => error);
    await waitForReads(1);
    readController.abort();
    describeController.abort();
    await Bun.sleep(40);
    finishReads[0]();

    expect(await engine.list(1)).toEqual(listing);
    expect([await read, await described]).toEqual([expect.any(CanceledError), expect.any(CanceledError)]);
    expect(InThreadWorker.created).toHaveLength(1);
});

test('engine lets a call run in a new worker past the start time limit of a worker that stopped while it loaded', async () => {
    const engine = connect({ timeLimitMs: 200 });
    const startedAt = Date.now();
    const controller = new AbortController();
    const described = engine.describe('|T:Shape', 'code', controller.signal);
    controller.abort();
    await expect(described).rejects.toBeInstanceOf(CanceledError);
    await Bun.sleep(100);
    await engine.open('a.dll', file);
    const read = engine.read(1, 2, 'code');
    await waitForReads(1);
    await Bun.sleep(startedAt + 250 - Date.now());

    finishReads[0]();

    expect(await read).toEqual(document);
    expect(InThreadWorker.created[0].isStopped).toBe(true);
});
