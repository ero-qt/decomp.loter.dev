import { expect, test } from 'bun:test';
import { InThreadWorker } from './in-thread-worker';
import { connect, file, handleCalls, hangOn, reportMemory, useQueueWorkers, useWorker } from './queue-testing';
import { EngineError, ok } from './reply';

useQueueWorkers();

test('engine sends 1 call at a time and counts the time limit of a call only while it runs', async () => {
    let atOnce = 0;
    let mostAtOnce = 0;
    handleCalls(async () => {
        mostAtOnce = Math.max(mostAtOnce, ++atOnce);
        await Bun.sleep(20);
        atOnce--;

        return ok(true);
    });
    const engine = connect({ timeLimitMs: 100 });

    const claimed = await Promise.all(Array.from({ length: 10 }, () => engine.claims('a.dll', file)));

    expect(claimed).toEqual(Array(10).fill(true));
    expect(mostAtOnce).toBe(1);
});

test('engine stops the worker of a call that runs longer than the time limit and runs the queued calls in a new worker', async () => {
    hangOn('read');
    const engine = connect({ timeLimitMs: 20 });

    const fileId = await engine.open('a.dll', file);
    const stopped = engine.read(fileId, 1, 'csharp').catch(error => error);
    const queued = engine.list(fileId);
    const error = await stopped;
    await queued;

    expect(error).toBeInstanceOf(EngineError);
    expect(error.message).toBe('The call ran longer than 0.02 seconds, so the page stopped the engine.');
    expect(InThreadWorker.created[0].isStopped).toBe(true);
    expect(InThreadWorker.created[1].calls).toEqual([['open', 1], ['list', 1]]);
});

test('engine stops a call that runs longer than the time limit after the worker sends `ready` again', async () => {
    hangOn('read');
    const engine = connect({ timeLimitMs: 20 });

    const fileId = await engine.open('a.dll', file);
    const stopped = engine.read(fileId, 1, 'csharp');
    InThreadWorker.created[0].send({ ready: true });

    await expect(Promise.race([stopped, Bun.sleep(100)])).rejects.toThrow('longer than 0.02 seconds');
});

test('engine stops a worker that reports more wasm memory than both the limit and twice its first report', async () => {
    reportMemory(100, 150, 250);
    const engine = connect({ memoryLimitBytes: 120 });

    await engine.open('a.dll', file);
    await engine.list(1);
    const stoppedBelowTwice = InThreadWorker.created[0].isStopped;
    await engine.list(1);
    const stoppedAboveTwice = InThreadWorker.created[0].isStopped;
    await engine.list(1);

    expect(stoppedBelowTwice).toBe(false);
    expect(stoppedAboveTwice).toBe(true);
    expect(InThreadWorker.created[1].calls).toEqual([['open', 1], ['list', 1]]);
});

test('engine compares the wasm memory of a new worker with the first report of the new worker', async () => {
    reportMemory(100, 250, 0, 300, 400);
    const engine = connect({ memoryLimitBytes: 120 });

    await engine.open('a.dll', file);
    await engine.list(1);
    await engine.list(1);
    await engine.list(1);

    expect(InThreadWorker.created).toHaveLength(2);
    expect(InThreadWorker.created[1].isStopped).toBe(false);
});

test('a worker whose first reply has no memory keeps running below twice its first memory', async () => {
    handleCalls(method => (method === 'claims' ? ok(true) : undefined));
    reportMemory(0, 100, 150);
    const engine = connect({ memoryLimitBytes: 120 });

    await engine.claims('a.dll', file);
    await engine.open('a.dll', file);
    await engine.list(1);

    expect(InThreadWorker.created).toHaveLength(1);
    expect(InThreadWorker.created[0].isStopped).toBe(false);
});

test('engine keeps a new worker whose setup grows the wasm memory past the limit', async () => {
    reportMemory(10, 100, 10, 100, 100, 100);
    const engine = connect({ memoryLimitBytes: 50 });

    await engine.open('a.dll', file);
    await engine.provide(1, 'a.pdb', file);
    await engine.list(1);
    await engine.list(1);

    expect(InThreadWorker.created).toHaveLength(2);
    expect(InThreadWorker.created[1].calls).toEqual([['open', 1], ['provide', 1], ['list', 1], ['list', 1]]);
});

test('engine keeps a worker without a memory limit however much wasm memory the worker reports', async () => {
    reportMemory(1, 2 ** 40);
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.list(1);

    expect(InThreadWorker.created[0].isStopped).toBe(false);
});

test('engine keeps the worker for the open of a file that the engine claims', async () => {
    handleCalls(method => (method === 'claims' ? ok(true) : undefined));
    const engine = connect();

    await engine.claims('a.dll', file);
    await engine.open('a.dll', file);

    expect(InThreadWorker.created).toHaveLength(1);
    expect(InThreadWorker.created[0].isStopped).toBe(false);
});

test("engine stops the worker after a file that the engine doesn't claim", async () => {
    handleCalls(method => (method === 'claims' ? ok(false) : undefined));
    const engine = connect();

    await engine.claims('a.txt', file);

    expect(InThreadWorker.created[0].isStopped).toBe(true);
});

test("engine stops the worker of a claimed file that doesn't open within the time limit", async () => {
    handleCalls(method => (method === 'claims' ? ok(true) : undefined));
    const engine = connect({ timeLimitMs: 20 });

    await engine.claims('a.dll', file);
    await Bun.sleep(50);

    expect(InThreadWorker.created[0].isStopped).toBe(true);
});

test("engine keeps the worker of a claimed file until the file's open, also after a file that the engine doesn't claim", async () => {
    handleCalls((method, [name]) => (method === 'claims' ? ok(name === 'a.dll') : undefined));
    const engine = connect();

    await engine.claims('a.dll', file);
    await engine.claims('b.txt', file);
    await engine.open('a.dll', file);
    await engine.close(1);

    expect(InThreadWorker.created).toHaveLength(1);
    expect(InThreadWorker.created[0].isStopped).toBe(true);
});

test('engine rejects the queued calls and stops a worker that takes longer than the time limit to get ready', async () => {
    let isStopped = false;
    class SilentWorker extends EventTarget {
        terminate() {
            isStopped = true;
        }
    }
    useWorker(SilentWorker);
    const engine = connect({ timeLimitMs: 20 });

    const calls = [engine.claims('a.dll', file), engine.claims('b.dll', file)].map(call => call.catch(error => error));
    const errors = await Promise.race([Promise.all(calls), Bun.sleep(100)]);

    expect(errors).toEqual(Array(2).fill(new EngineError("The engine didn't start within 0.02 seconds.")));
    expect(errors?.every(error => error instanceof EngineError)).toBe(true);
    expect(isStopped).toBe(true);
});
