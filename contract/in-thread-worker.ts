import { type EngineHandlers, serveEngine, type WorkerMessage, type WorkerPort, type WorkerRequest } from './serve';

const RealWorker = globalThis.Worker;

function refuseWorker(): never {
    throw new Error("the in-thread worker doesn't have handlers because the test didn't call useInThreadWorker");
}

/** A worker for tests that serves an engine's handlers in the test's thread and sends each message 1 ms later. */
export class InThreadWorker extends EventTarget {
    static created: InThreadWorker[] = [];
    /** Returns a new worker's handlers from the worker's index in `created`. */
    static createHandlers: (index: number) => EngineHandlers = refuseWorker;
    static readWasmMemoryBytes?: () => number;
    received: WorkerRequest[] = [];
    isStopped = false;
    port: WorkerPort = {
        onmessage: null,
        postMessage: message => {
            setTimeout(() => this.isStopped || this.send(message), 1);
        },
    };

    constructor() {
        super();
        const handlers = InThreadWorker.createHandlers(InThreadWorker.created.push(this) - 1);
        setTimeout(() => serveEngine(this.port, handlers, InThreadWorker.readWasmMemoryBytes));
    }

    postMessage(request: WorkerRequest) {
        this.received.push(request);
        this.port.onmessage?.(new MessageEvent('message', { data: request }));
    }

    terminate() {
        this.isStopped = true;
    }

    send(message: WorkerMessage) {
        this.dispatchEvent(new MessageEvent('message', { data: message }));
    }

    /** The method and the first argument of each call that the worker got, without the cancel messages. */
    get calls() {
        return this.received.filter(request => 'method' in request).map(({ method, args }) => [method, args[0]]);
    }
}

/** Replaces the global `Worker` with `InThreadWorker` and empties `InThreadWorker.created`. */
export function useInThreadWorker(createHandlers: (index: number) => EngineHandlers, readWasmMemoryBytes?: () => number) {
    InThreadWorker.created = [];
    InThreadWorker.createHandlers = createHandlers;
    InThreadWorker.readWasmMemoryBytes = readWasmMemoryBytes;
    globalThis.Worker = InThreadWorker as unknown as typeof Worker;
}

export function restoreWorker() {
    globalThis.Worker = RealWorker;
    InThreadWorker.createHandlers = refuseWorker;
}
