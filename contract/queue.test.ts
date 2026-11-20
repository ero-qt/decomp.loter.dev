import { expect, test } from 'bun:test';
import { InThreadWorker } from './in-thread-worker';
import { BrokenWorker, connect, crashOn, file, handleCalls, hangOn, hung, refuseAgain, useQueueWorkers, useWorker } from './queue-testing';
import { EngineError, failed, ok } from './reply';

useQueueWorkers();

test('engine opens files under ids that count up from 1 and sends each id to the worker', async () => {
    const engine = connect();

    expect(await engine.open('a.dll', file)).toBe(1);
    expect(await engine.open('b.dll', file)).toBe(2);
    expect(InThreadWorker.created[0].received).toEqual([
        { method: 'open', args: [1, 'a.dll', file] },
        { method: 'open', args: [2, 'b.dll', file] },
    ]);
});

test('engine returns the value of a reply and throws the error text of a failed reply as an engine error', async () => {
    handleCalls(method => (method === 'claims' ? ok(true) : failed("a.dll isn't an assembly.")));
    const engine = connect();

    expect(await engine.claims('a.dll', file)).toBe(true);
    await expect(engine.open('a.dll', file)).rejects.toThrow(new EngineError("a.dll isn't an assembly."));
});

test('engine rejects a reply whose value breaks the contract', async () => {
    handleCalls(method => (method === 'describe' ? ok({ text: 3 }) : undefined));
    const engine = connect();

    const error = await engine.describe('|T:Shape', 'csharp').catch(error => error);

    expect(error).toEqual(new Error("the reply of describe has a text that isn't a string"));
    expect(error).not.toBeInstanceOf(EngineError);
});

test('engine sends nothing to a new worker before the worker is ready', async () => {
    const engine = connect();

    const claimed = engine.claims('a.dll', file);
    const receivedBeforeReady = [...InThreadWorker.created[0].received];
    await claimed;

    expect(receivedBeforeReady).toEqual([]);
    expect(InThreadWorker.created[0].calls).toEqual([['claims', 'a.dll']]);
});

test('engine rejects a call that crashes the worker and opens its file again for the next call', async () => {
    crashOn('read');
    const engine = connect();

    const fileId = await engine.open('a.dll', file);
    const error = await engine.read(fileId, 1, 'csharp').catch(error => error);
    await engine.list(fileId);

    expect(error.message).toBe('Maximum call stack size exceeded.');
    expect(error).not.toBeInstanceOf(EngineError);
    expect(InThreadWorker.created[0].isStopped).toBe(true);
    expect(InThreadWorker.created[1].calls).toEqual([['open', 1], ['list', 1]]);
});

test('engine rejects a call whose worker fails with an empty text', async () => {
    handleCalls(() => {
        throw new Error('');
    });
    const engine = connect();

    await expect(engine.claims('a.dll', file)).rejects.toThrow();
});

test("engine rejects a call whose worker sends a message that the page can't read", async () => {
    hangOn('claims');
    const engine = connect();

    const claimed = engine.claims('a.dll', file);
    await Bun.sleep(5);
    InThreadWorker.created[0].dispatchEvent(new MessageEvent('messageerror'));

    await expect(claimed).rejects.toThrow("the page couldn't read a message of the worker");
    expect(InThreadWorker.created[0].isStopped).toBe(true);
});

test('engine rejects every queued call when the worker fails before it is ready and starts a new worker for the next call', async () => {
    const engine = connect();

    const calls = [engine.claims('a.dll', file), engine.claims('b.dll', file)];
    InThreadWorker.created[0].dispatchEvent(new ErrorEvent('error', { message: "The worker's script didn't load." }));
    const errors = await Promise.all(calls.map(queued => queued.catch(error => error.message)));
    await engine.claims('a.dll', file);

    expect(errors).toEqual(["The worker's script didn't load.", "The worker's script didn't load."]);
    expect(InThreadWorker.created[0].received).toEqual([]);
    expect(InThreadWorker.created[1].calls).toEqual([['claims', 'a.dll']]);
});

test('engine resolves a queued close and forgets the file when the worker fails before it is ready', async () => {
    crashOn('read');
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    const listed = engine.list(1).catch(error => error.message);
    const closed = engine.close(1);
    InThreadWorker.created[1].dispatchEvent(new ErrorEvent('error', { message: "The worker's script didn't load." }));

    expect(await listed).toBe("The worker's script didn't load.");
    expect(await closed).toBeUndefined();
    await expect(engine.list(1)).rejects.toThrow("The worker doesn't have the file 1.");
});

test('engine resolves a close that crashes the worker', async () => {
    crashOn('close');
    const engine = connect();

    await engine.open('a.dll', file);

    expect(await engine.close(1)).toBeUndefined();
});

test('engine drops a call whose worker fails to start', async () => {
    useWorker(BrokenWorker);
    const engine = connect();

    await expect(engine.open('a.dll', file)).rejects.toThrow("The browser can't start a worker.");
    useWorker(InThreadWorker);
    await engine.claims('b.dll', file);

    expect(InThreadWorker.created[0].calls).toEqual([['claims', 'b.dll']]);
});

test('engine rejects the queued calls when the next worker fails to start after a crash', async () => {
    crashOn('read');
    const engine = connect();

    await engine.open('a.dll', file);
    const crashed = engine.read(1, 1, 'csharp').catch(() => {});
    const queued = engine.list(1);
    useWorker(BrokenWorker);
    await crashed;

    await expect(queued).rejects.toThrow("The browser can't start a worker.");
});

test('engine ignores the messages and errors of a worker that it stopped', async () => {
    handleCalls(method => (method === 'read' ? hung : ok('1:1')));
    const engine = connect({ timeLimitMs: 20 });

    await expect(engine.read(1, 1, 'csharp')).rejects.toThrow('longer than 0.02 seconds');
    const resolved = engine.resolve('|T:Shape');
    const [stopped] = InThreadWorker.created;
    stopped.send({ ready: true });
    stopped.send({ reply: ok('1:2') });
    stopped.dispatchEvent(new ErrorEvent('error', { message: 'The stopped worker failed.' }));

    expect(await resolved).toBe('1:1');
});

test('engine opens only the file of a call again in a new worker, with its provided files in order', async () => {
    crashOn('read');
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.provide(1, 'a.pdb', file);
    await engine.provide(1, 'a.xml', file);
    await engine.read(2, 1, 'csharp').catch(() => {});
    await engine.list(1);
    await engine.list(1);

    const sent = InThreadWorker.created[1].received
        .filter(request => 'method' in request)
        .map(({ method, args }) => [method, ...args.slice(0, 2)]);

    expect(sent).toEqual([
        ['open', 1, 'a.dll'],
        ['provide', 1, 'a.pdb'],
        ['provide', 1, 'a.xml'],
        ['list', 1],
        ['list', 1],
    ]);
});

test("engine doesn't send a refused open or provide to a new worker", async () => {
    handleCalls((method, [fileId, name]) => {
        if (method === 'read') {
            throw new Error('Maximum call stack size exceeded.');
        }

        return fileId === 2 || name === 'a.pdb' ? failed("The file isn't readable.") : undefined;
    });
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.open('b.dll', file).catch(() => {});
    await engine.provide(1, 'a.pdb', file).catch(() => {});
    await engine.read(1, 1, 'csharp').catch(() => {});
    await engine.resolve('|T:Shape');

    expect(InThreadWorker.created[1].calls).toEqual([['open', 1], ['resolve', '|T:Shape']]);
});

test('engine opens the file of a target again in a new worker and every open file for a target outside the open files', async () => {
    crashOn('read');
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.open('c.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    await engine.describe('2:2000004', 'csharp');
    await engine.resolve('|T:Shape');

    expect(InThreadWorker.created[1].calls).toEqual([
        ['open', 2],
        ['describe', '2:2000004'],
        ['open', 1],
        ['open', 3],
        ['resolve', '|T:Shape'],
    ]);
});

test('engine opens no file again in a new worker for a call with the file id 0', async () => {
    crashOn('read');
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    await engine.list(0).catch(() => {});

    expect(InThreadWorker.created[1].calls).toEqual([['list', 0]]);
});

test('engine opens every file again in a new worker before a call when the files depend on each other', async () => {
    crashOn('read');
    const engine = connect({ hasLinkedFiles: true });

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    await engine.list(2);

    expect(InThreadWorker.created[1].calls).toEqual([['open', 1], ['open', 2], ['list', 2]]);
});

test('engine checks a file in a new worker without opening the other files again', async () => {
    crashOn('read');
    const engine = connect({ hasLinkedFiles: true });

    await engine.open('a.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    await engine.claims('b.dll', file);

    expect(InThreadWorker.created[1].calls).toEqual([['claims', 'b.dll']]);
});

test('engine rejects the calls for a file that a new worker refuses to open again and keeps the other files', async () => {
    refuseAgain(1);
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.provide(1, 'a.pdb', file);
    await engine.read(2, 1, 'csharp').catch(() => {});
    await engine.list(2);
    const error = await engine.list(1).catch(error => error);

    expect(error).toBeInstanceOf(EngineError);
    expect(error.message).toBe("The engine couldn't open a.dll again after a restart.");
    expect(error.cause.message).toBe("The file isn't readable.");
    await expect(engine.list(1)).rejects.toThrow("The engine couldn't open a.dll again after a restart.");
    expect(InThreadWorker.created[1].calls).toEqual([['open', 2], ['list', 2], ['open', 1]]);
});

test('engine keeps the error of each file that a new worker refuses to open again', async () => {
    refuseAgain(1, 2);
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.open('c.dll', file);
    await engine.read(3, 1, 'csharp').catch(() => {});
    await engine.list(3);

    await expect(engine.list(1)).rejects.toThrow("The engine couldn't open a.dll again after a restart.");
    await expect(engine.list(2)).rejects.toThrow("The engine couldn't open b.dll again after a restart.");
    await expect(engine.list(1)).rejects.toThrow("The engine couldn't open a.dll again after a restart.");
});

test('engine loses a file whose open crashes a new worker and opens the other files once in the next worker', async () => {
    handleCalls((method, [fileId], worker) => {
        if (method === 'read' || (worker === 1 && method === 'open' && fileId === 1)) {
            throw new Error('The worker ran out of memory.');
        }

        return undefined;
    });
    const engine = connect({ hasLinkedFiles: true });

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    await engine.list(2);
    const error = await engine.list(1).catch(error => error);

    expect(error.message).toBe("The engine couldn't open a.dll again after a restart.");
    expect(error.cause.message).toBe('The worker ran out of memory.');
    expect(InThreadWorker.created).toHaveLength(3);
    expect(InThreadWorker.created[2].calls).toEqual([['open', 2], ['list', 2]]);
});

test('engine keeps a file whose setup is queued when the worker crashes and the next worker fails to start', async () => {
    handleCalls((method, [fileId], worker) => {
        if (method === 'read' || (worker === 1 && method === 'open' && fileId === 1)) {
            throw new Error('The worker ran out of memory.');
        }

        return undefined;
    });
    const engine = connect({ hasLinkedFiles: true });

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    const listed = engine.list(2).catch(error => error.message);
    useWorker(BrokenWorker);

    expect(await listed).toBe("The browser can't start a worker.");
    useWorker(InThreadWorker);
    await engine.list(2);
    expect(InThreadWorker.created[2].calls).toEqual([['open', 2], ['list', 2]]);
});

test('engine stops the worker that loses the last open file and rejects the next call for the file without a worker', async () => {
    refuseAgain(1);
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    await engine.list(1).catch(() => {});
    const isStopped = InThreadWorker.created[1].isStopped;
    await engine.list(1).catch(() => {});

    expect(isStopped).toBe(true);
    expect(InThreadWorker.created).toHaveLength(2);
});

test('engine closes a lost file without a call to the worker and forgets that the file is lost', async () => {
    refuseAgain(1);
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.read(2, 1, 'csharp').catch(() => {});
    await engine.list(2);
    await engine.list(1).catch(() => {});
    await engine.close(1);

    expect(InThreadWorker.created[1].calls).toEqual([['open', 2], ['list', 2], ['open', 1]]);
    await expect(engine.list(1)).rejects.toThrow("The worker doesn't have the file 1.");
});

test('engine closes a file without a call to the worker when the current worker never opened the file', async () => {
    crashOn('read');
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    await engine.list(2);
    await engine.close(1);

    expect(InThreadWorker.created[1].calls).toEqual([['open', 2], ['list', 2]]);
    await expect(engine.list(1)).rejects.toThrow(new EngineError("The worker doesn't have the file 1."));
});

test('engine closes a file without a worker after the worker of the file crashed', async () => {
    crashOn('read');
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.read(1, 1, 'csharp').catch(() => {});
    await Bun.sleep(5);
    await engine.close(1);

    expect(InThreadWorker.created).toHaveLength(1);
});

test('engine closes 100000 files in a row that no worker opened', async () => {
    const engine = connect();

    const claimed = engine.claims('a.dll', file);
    const closed = Array.from({ length: 100_000 }, (_, index) => engine.close(index + 1));
    await Promise.all([claimed, ...closed]);

    expect(InThreadWorker.created[0].calls).toEqual([['claims', 'a.dll']]);
});

test('engine runs the calls queued before a close against the file in a new worker', async () => {
    hangOn('read');
    const engine = connect({ timeLimitMs: 20 });

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    const stopped = engine.read(1, 1, 'csharp').catch(() => {});
    await Promise.all([stopped, engine.list(1), engine.close(1)]);

    expect(InThreadWorker.created[1].calls).toEqual([['open', 1], ['list', 1], ['close', 1]]);
});

test('engine stops the worker after the last open file is closed and starts a new worker for the next file', async () => {
    const engine = connect();

    await engine.open('a.dll', file);
    await engine.open('b.dll', file);
    await engine.close(1);
    const stoppedAfterFirst = InThreadWorker.created[0].isStopped;
    await engine.close(2);
    await Bun.sleep(5);

    expect(stoppedAfterFirst).toBe(false);
    expect(InThreadWorker.created[0].isStopped).toBe(true);
    expect(InThreadWorker.created).toHaveLength(1);
    expect(await engine.open('c.dll', file)).toBe(3);
    expect(InThreadWorker.created[1].calls).toEqual([['open', 3]]);
});

test('engine keeps the worker after the last close when another call is queued', async () => {
    const engine = connect();

    await engine.open('a.dll', file);
    await Promise.all([engine.close(1), engine.open('b.dll', file)]);

    expect(InThreadWorker.created).toHaveLength(1);
    expect(InThreadWorker.created[0].calls).toEqual([['open', 1], ['close', 1], ['open', 2]]);
});
