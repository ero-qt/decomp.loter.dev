import { afterEach, beforeEach } from 'bun:test';
import type { Engine } from './engine';
import { restoreWorker, useInThreadWorker } from './in-thread-worker';
import { type ConnectOptions, connectEngine } from './queue';
import { failed, ok, type Reply } from './reply';
import type { EngineHandlers } from './serve';

/**
 * Returns the reply of a call from the method, the arguments and the index of the worker, or `undefined` for the usual
 * reply.
 */
export type Handle = (method: keyof Engine, args: unknown[], worker: number) => Reply<unknown> | Promise<Reply<unknown>> | undefined;

export const file = new Blob(['a']);
/** A reply that never comes. */
export const hung = new Promise<never>(() => {});
// method -> the value of the usual reply, which `readReplyValue` accepts
const usualValues: Partial<Record<keyof Engine, unknown>> = {
    claims: false,
    list: { values: new Int32Array(), names: [], details: [], note: '', missingFiles: [] },
    read: { text: '', tokens: new Int32Array(), targets: [], locals: [] },
    findReferences: [],
    listStrings: [],
};

let handle: Handle;
// the wasm memory that the next replies report
let wasmMemoryBytes: number[];

/** Sets the handle that gives the reply to each call of every worker until the test ends. */
export function handleCalls(next: Handle) {
    handle = next;
}

/** Makes the next replies report these sizes of the wasm memory, one for each reply, and 0 after the last. */
export function reportMemory(...bytes: number[]) {
    wasmMemoryBytes = bytes;
}

function createHandlers(index: number): EngineHandlers {
    const fileIds = new Set<unknown>();

    function replyAsUsual(method: keyof Engine, [first]: unknown[]): Reply<unknown> {
        if (method === 'open') {
            fileIds.add(first);
        } else if (typeof first === 'number' && !fileIds.has(first)) {
            return failed(`The worker doesn't have the file ${first}.`);
        } else if (method === 'close') {
            fileIds.delete(first);
        }

        return ok(usualValues[method] ?? null);
    }

    const handlers = new Proxy({}, {
        get: (_, method: keyof Engine) => (...args: unknown[]) => handle(method, args, index) ?? replyAsUsual(method, args),
    });

    return handlers as EngineHandlers;
}

export function connect(options: Partial<ConnectOptions> = {}): Engine {
    return connectEngine('worker.js', { timeLimitMs: 1000, cancelLimitMs: 1000, ...options });
}

/** A worker that the browser can't start. */
export class BrokenWorker {
    constructor() {
        throw new Error("The browser can't start a worker.");
    }
}

/** Replaces the global `Worker` with the worker class. */
export function useWorker(worker: unknown) {
    globalThis.Worker = worker as typeof Worker;
}

/** Crashes the worker on each call with the method. */
export function crashOn(crashing: keyof Engine) {
    handle = method => {
        if (method === crashing) {
            throw new Error('Maximum call stack size exceeded.');
        }

        return undefined;
    };
}

/** Never replies to a call with the method. */
export function hangOn(hanging: keyof Engine) {
    handle = method => (method === hanging ? hung : undefined);
}

/** Refuses the `open` of the files with these ids in every worker after the first worker, which crashes on `read`. */
export function refuseAgain(...fileIds: unknown[]) {
    handle = (method, [fileId], worker) => {
        if (method === 'read') {
            throw new Error('Maximum call stack size exceeded.');
        }

        return worker > 0 && method === 'open' && fileIds.includes(fileId) ? failed("The file isn't readable.") : undefined;
    };
}

/**
 * Serves the handlers of `handleCalls` in in-thread workers during each test of a file, with the usual replies at
 * first.
 */
export function useQueueWorkers() {
    beforeEach(() => {
        useInThreadWorker(createHandlers, () => wasmMemoryBytes.shift() ?? 0);
        handle = () => undefined;
        wasmMemoryBytes = [];
    });

    afterEach(restoreWorker);
}
