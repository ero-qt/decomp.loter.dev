import { expect, test } from 'bun:test';
import { failed, ok } from './reply';
import { type EngineHandlers, serveEngine, type WorkerMessage, type WorkerPort, type WorkerRequest } from './serve';

const file = new Blob(['a']);

// serves the handlers on a port that keeps a copy of each message, and returns the function that sends a request to the
// port
function serve(handlers: Partial<EngineHandlers>, readWasmMemoryBytes?: () => number) {
    const sent: WorkerMessage[] = [];
    const port: WorkerPort = {
        onmessage: null,
        postMessage(message) {
            sent.push(structuredClone(message));
        },
    };
    serveEngine(port, handlers as EngineHandlers, readWasmMemoryBytes);

    async function request(data: WorkerRequest): Promise<WorkerMessage | undefined> {
        await port.onmessage?.(new MessageEvent('message', { data }));

        return sent.at(-1);
    }

    return { sent, port, request };
}

test('serveEngine sends ready before the first request', () => {
    const { sent } = serve({});

    expect(sent).toEqual([{ ready: true }]);
});

test('serveEngine calls the handler of a request with the arguments of the request and sends the reply', async () => {
    const opened: unknown[][] = [];
    const { request } = serve({
        async open(...args) {
            await Bun.sleep(1);
            opened.push(args);

            return ok(undefined);
        },
        list: fileId => failed(`The engine doesn't have the file ${fileId}.`),
    });

    expect(await request({ method: 'open', args: [3, 'a.dll', file] })).toEqual({ reply: { value: undefined } });
    expect(await request({ method: 'list', args: [4] })).toEqual({ reply: { error: "The engine doesn't have the file 4." } });
    expect(opened).toEqual([[3, 'a.dll', file, expect.any(AbortSignal)]]);
});

test('serveEngine sends the size of the wasm memory after each call', async () => {
    let memory = 4096;
    const { request } = serve({ close: () => ok(undefined) }, () => (memory *= 2));

    expect(await request({ method: 'close', args: [1] })).toEqual({ reply: { value: undefined }, wasmMemoryBytes: 8192 });
    expect(await request({ method: 'close', args: [1] })).toEqual({ reply: { value: undefined }, wasmMemoryBytes: 16384 });
});

test('serveEngine sends the text of what a handler throws as fatal', async () => {
    const { request } = serve({
        close() {
            throw new RangeError('Maximum call stack size exceeded.');
        },
        list() {
            throw 'out of memory';
        },
    });

    expect(await request({ method: 'close', args: [1] })).toEqual({ fatal: 'Maximum call stack size exceeded.' });
    expect(await request({ method: 'list', args: [1] })).toEqual({ fatal: 'out of memory' });
});

test("serveEngine sends fatal for a reply that the port can't copy", async () => {
    const { request } = serve({ resolve: () => ok((() => {}) as unknown as string) });

    expect(await request({ method: 'resolve', args: ['|T:Shape'] })).toEqual({ fatal: expect.stringContaining('clone') });
});

test("serveEngine aborts the running call's signal for a cancel message and sends a failed reply when the handler then throws", async () => {
    const signals: AbortSignal[] = [];
    const { sent, port } = serve({
        read(_fileId, _key, _view, signal) {
            signals.push(signal);

            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('the read stopped'))));
        },
    });

    const replied = port.onmessage?.(new MessageEvent('message', { data: { method: 'read', args: [1, 2, 'code'] } }));
    await port.onmessage?.(new MessageEvent('message', { data: { cancel: true } }));
    await replied;

    expect(signals.map(signal => signal.aborted)).toEqual([true]);
    expect(sent.at(-1)).toEqual({ reply: { error: 'The call was canceled.' } });
});

test('serveEngine sends the size of the wasm memory with the failed reply of a canceled call', async () => {
    const { sent, port } = serve({
        read: (_fileId, _key, _view, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))),
    }, () => 8192);

    const replied = port.onmessage?.(new MessageEvent('message', { data: { method: 'read', args: [1, 2, 'code'] } }));
    await port.onmessage?.(new MessageEvent('message', { data: { cancel: true } }));
    await replied;

    expect(sent.at(-1)).toEqual({ reply: { error: 'The call was canceled.' }, wasmMemoryBytes: 8192 });
});

test('serveEngine ignores a cancel message while no call runs', async () => {
    const { sent, request } = serve({});

    await request({ cancel: true });

    expect(sent).toEqual([{ ready: true }]);
});

test('serveEngine sends fatal for a method without a handler', async () => {
    const { request } = serve({});

    expect(await request({ method: 'list', args: [1] })).toEqual({ fatal: expect.stringContaining('not a function') });
});
