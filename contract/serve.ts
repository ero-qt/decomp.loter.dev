import type { Engine } from './engine';
import { failed, type Reply } from './reply';

/** A call that the page sends to an engine's worker. */
export interface CallRequest {
    method: keyof Engine;
    args: unknown[];
}

/** A message that the page sends to an engine's worker: a call, or `cancel` for the running call. */
export type WorkerRequest = CallRequest | { cancel: true };

/**
 * A message that an engine's worker sends to the page. The worker sends `ready` once after the engine loads, then the
 * reply of each request, or `fatal` with the error text of a handler that throws, which leaves the worker in an unknown
 * state.
 */
export type WorkerMessage = { ready: true } | { reply: Reply<unknown>; wasmMemoryBytes?: number } | { fatal: string };

type Handler<Args extends unknown[], Value> = (...args: [...Args, signal: AbortSignal]) => Reply<Value> | Promise<Reply<Value>>;

// drops the signal that `Engine` takes after the arguments of a call because `serveEngine` gives each handler a signal
type WithoutSignal<Args extends unknown[]> = Required<Args> extends [...infer Rest, AbortSignal] ? Rest : Args;

type HandlerOf<Call> = Call extends (...args: infer Args) => Promise<infer Value> ? Handler<WithoutSignal<Args>, Value> : never;

/**
 * The calls of `Engine` as an engine's worker handles them. A handler returns a failed reply for a call that the engine
 * refuses and only throws for a bug or after its signal aborts. `open` gets the id of the new file before its other
 * arguments. Each handler gets a signal after its arguments, which aborts when the page cancels the call.
 */
export type EngineHandlers = {
    [Method in Exclude<keyof Engine, 'open'>]: HandlerOf<Engine[Method]>;
} & {
    open: Handler<[fileId: number, name: string, file: Blob], void>;
};

/** The part of a worker's global scope that `serveEngine` uses. */
export interface WorkerPort {
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(message: WorkerMessage): void;
}

/**
 * Runs the handler of each request that the page sends and sends the handler's reply back, with the size of the
 * engine's wasm memory for an engine that runs in wasm. A `cancel` request aborts the running call's signal. For a
 * handler that throws after the abort, the page gets a failed reply in place of `fatal`, because the abort stopped the
 * handler. A worker passes `self` as the port after the worker's engine loads.
 */
export function serveEngine(port: WorkerPort, handlers: EngineHandlers, readWasmMemoryBytes?: () => number): void {
    let running: AbortController | undefined;
    port.onmessage = async function ({ data }) {
        if ('cancel' in data) {
            running?.abort();
            return;
        }

        const controller = new AbortController();
        running = controller;
        try {
            const handler = handlers[data.method] as Handler<unknown[], unknown>;
            port.postMessage({ reply: await handler(...data.args, controller.signal), wasmMemoryBytes: readWasmMemoryBytes?.() });
        } catch (error) {
            if (controller.signal.aborted) {
                port.postMessage({ reply: failed('The call was canceled.'), wasmMemoryBytes: readWasmMemoryBytes?.() });
            } else {
                port.postMessage({ fatal: error instanceof Error ? error.message : String(error) });
            }
        } finally {
            if (running === controller) {
                running = undefined;
            }
        }
    };

    port.postMessage({ ready: true });
}
