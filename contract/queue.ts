import { parseTarget } from './document';
import type { Engine } from './engine';
import { readReplyValue } from './replies';
import { CanceledError, EngineError, type Reply, unwrap } from './reply';
import type { WorkerMessage, WorkerRequest } from './serve';

/** The limits of an engine's worker and whether the engine's files depend on each other. */
export interface ConnectOptions {
    /** The time in milliseconds that a call may run, a new worker may load or a claimed file may wait for its open. */
    timeLimitMs: number;
    /**
     * The time in milliseconds that a canceled call may keep running while another call waits, after which the worker
     * stops and the waiting calls run in a new worker.
     */
    cancelLimitMs: number;
    /**
     * The size in bytes of the worker's wasm memory above which the worker stops after a call, so the next call starts
     * a new worker with less memory. A worker below twice the memory of its first reply that reports memory keeps
     * running.
     */
    memoryLimitBytes?: number;
    /**
     * Whether a file's results depend on the other open files, like an assembly that references another assembly. A new
     * worker then opens every open file again before the worker's first call.
     */
    hasLinkedFiles?: boolean;
    /** Whether the worker replies to `describe` and `resolve` while a `read` waits. */
    repliesDuringReads?: boolean;
}

interface QueuedCall {
    method: keyof Engine;
    args: unknown[];
    /**
     * The id of the call's file, `'every'` for a target without a file id, like a local or a symbol outside the open
     * files, or `undefined` for a call without a file.
     */
    fileId: number | 'every' | undefined;
    isSetup?: boolean;
    isCanceled?: boolean;
    resolve(reply: Reply<unknown>): void;
    reject(error: unknown): void;
}

interface OpenFile {
    name: string;
    /** The `open` and `provide` calls that a new worker gets again. */
    setup: Pick<QueuedCall, 'method' | 'args'>[];
}

const toleratedMemoryGrowth = 2;
// the calls that go to the worker beside a waiting `read` when the worker replies during reads
const sideMethods: (keyof Engine)[] = ['describe', 'resolve'];

function findFileId(method: keyof Engine, [first]: unknown[]): QueuedCall['fileId'] {
    if (typeof first === 'number') {
        return first;
    }
    if (method === 'claims') {
        return undefined;
    }

    const target = parseTarget(String(first));

    return 'fileId' in target ? target.fileId : 'every';
}

/**
 * Returns an engine whose calls run one at a time in a module worker that starts with the first call. A call that
 * crashes the worker or runs longer than the time limit rejects. The calls after that call run in a new worker, which
 * opens a file again under the same id before the first call for that file, so the page's file ids and targets stay
 * valid. The worker stops after a call that leaves neither an open file nor a claimed file. A claimed file only keeps
 * the worker until the time limit. A call whose signal aborts rejects at once with a `CanceledError`. A canceled call
 * that runs past the cancel limit while another call waits stops the worker like a call past the time limit.
 */
export function connectEngine(workerUrl: string | URL | TrustedScriptURL, options: ConnectOptions): Engine {
    const queue: QueuedCall[] = [];
    const openFiles = new Map<number, OpenFile>();
    // file id -> the error of a file that a new worker couldn't open again
    const lostFiles = new Map<number, EngineError>();
    const openedFileIds = new Set<number>();
    let nextFileId = 1;
    let worker: Worker | undefined;
    let isReady = false;
    let runningCall: QueuedCall | undefined;
    // the call that runs beside a waiting `read`, with the id in its request and its reply
    let sideCall: { call: QueuedCall; id: number } | undefined;
    let nextCallId = 1;
    let timeLimitTimer: ReturnType<typeof setTimeout> | undefined;
    let claimTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelLimitTimer: ReturnType<typeof setTimeout> | undefined;
    let firstMemoryBytes: number | undefined;
    // keeps the worker from a claimed file until the next `open` or the time limit, because a new worker would load the
    // engine again
    let hasClaimedFile = false;

    function start() {
        // casts a trusted URL because TypeScript's `Worker` only takes a string or a `URL`
        const startedWorker = new Worker(workerUrl as string | URL, { type: 'module' });
        worker = startedWorker;
        // limits the time until `ready` because a worker that never gets ready would leave every call pending
        startTimeLimit(seconds => `The engine didn't start within ${seconds}.`);

        // ignores the events of a stopped worker because a browser may deliver the events after the stop
        startedWorker.addEventListener('message', ({ data }: MessageEvent<WorkerMessage>) => {
            if (startedWorker === worker) {
                receive(data);
            }
        });
        function crash(event: Event) {
            if (startedWorker === worker) {
                fail(new Error('message' in event ? String(event.message) : "the page couldn't read a message of the worker"));
            }
        }
        startedWorker.addEventListener('error', crash);
        startedWorker.addEventListener('messageerror', crash);
    }

    function startTimeLimit(describe: (seconds: string) => string) {
        const seconds = options.timeLimitMs / 1000;
        const text = describe(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
        timeLimitTimer = setTimeout(() => fail(new EngineError(text)), options.timeLimitMs);
    }

    function claimFile() {
        hasClaimedFile = true;
        clearTimeout(claimTimer);
        claimTimer = setTimeout(() => {
            hasClaimedFile = false;
            sendNext();
        }, options.timeLimitMs);
    }

    function stop() {
        // queues a call that ran beside a read again, so the next worker runs it
        if (sideCall) {
            queue.unshift(sideCall.call);
            sideCall = undefined;
        }

        worker?.terminate();
        worker = undefined;
        isReady = false;
        openedFileIds.clear();
        firstMemoryBytes = undefined;
        hasClaimedFile = false;
        clearTimeout(claimTimer);
        clearTimeout(timeLimitTimer);
        // drops the queued setup calls because a new worker queues the whole setup of each file that a call needs
        queue.splice(0, queue.length, ...queue.filter(queued => !queued.isSetup));
    }

    function receive(message: WorkerMessage) {
        if ('ready' in message) {
            // ignores a second `ready` because the timer then limits a running call
            if (!isReady) {
                isReady = true;
                clearTimeout(timeLimitTimer);
            }
        } else if ('fatal' in message) {
            fail(new Error(message.fatal));
            return;
        } else if (message.id !== undefined) {
            if (sideCall?.id === message.id) {
                const finished = sideCall.call;
                sideCall = undefined;
                finished.resolve(message.reply);
            }
        } else {
            const { reply, wasmMemoryBytes = 0 } = message;
            const finished = finishRunning();
            finished?.resolve(reply);
            if (finished?.method === 'open') {
                hasClaimedFile = false;
                clearTimeout(claimTimer);
            } else if (finished?.method === 'claims' && reply.value === true) {
                claimFile();
            }
            // skips a reply without memory, like an engine's `claims` before its runtime loads, because a first memory
            // of 0 would stop the worker after any later call above the limit
            if (!finished?.isSetup && wasmMemoryBytes > 0) {
                firstMemoryBytes ??= wasmMemoryBytes;
                // keeps a worker running below twice the memory of its first reply that reports memory, because a new
                // worker that needs as much memory for the same files would be stopped after every call
                if (wasmMemoryBytes > Math.max(options.memoryLimitBytes ?? Infinity, toleratedMemoryGrowth * firstMemoryBytes)) {
                    stop();
                }
            }
        }

        sendNext();
    }

    function sendNext() {
        while (!runningCall && queue.length > 0) {
            const [next] = queue;
            if (settleWithoutWorker(next)) {
                queue.shift();
            } else if (!worker) {
                try {
                    start();
                } catch (error) {
                    rejectCalls(queue.splice(0), error);
                }
            } else if (!isReady) {
                return;
            } else if (!queueSetup(next)) {
                queue.shift();
                runningCall = next;
                // starts the time limit when the call is sent because the wait in the queue doesn't count
                startTimeLimit(seconds => `The call ran longer than ${seconds}, so the page stopped the engine.`);
                worker.postMessage({ method: next.method, args: next.args } satisfies WorkerRequest);
            }
        }

        if (!runningCall && openFiles.size === 0 && !hasClaimedFile) {
            stop();
        }

        sendSideCall();
    }

    // sends a queued `describe` or `resolve` beside a waiting `read` when the worker replies during reads and already
    // opened the call's files
    function sendSideCall() {
        if (!options.repliesDuringReads || sideCall || runningCall?.method !== 'read' || !worker || !isReady) {
            return;
        }

        const index = queue.findIndex(queued => sideMethods.includes(queued.method) && hasOpenedFiles(queued));
        if (index >= 0) {
            const [call] = queue.splice(index, 1);
            sideCall = { call, id: nextCallId++ };
            worker.postMessage({ method: call.method, args: call.args, id: sideCall.id } satisfies WorkerRequest);
        }
    }

    function hasOpenedFiles({ fileId }: QueuedCall): boolean {
        if (typeof fileId === 'number' && !options.hasLinkedFiles) {
            return openedFileIds.has(fileId);
        }

        return [...openFiles.keys()].every(id => openedFileIds.has(id));
    }

    function settleWithoutWorker({ method, fileId, resolve, reject }: QueuedCall): boolean {
        if (typeof fileId !== 'number') {
            return false;
        }

        const lostError = lostFiles.get(fileId);
        if (method === 'close') {
            // only forgets a file when its close is sent because the calls queued before the close still need the file
            openFiles.delete(fileId);
            lostFiles.delete(fileId);
            if (openedFileIds.delete(fileId)) {
                return false;
            }

            resolve({ value: undefined });
        } else if (lostError) {
            reject(lostError);
        }

        return method === 'close' || lostError !== undefined;
    }

    function queueSetup({ fileId, isSetup }: QueuedCall): boolean {
        if (isSetup || fileId === undefined) {
            return false;
        }

        const needsEveryFile = options.hasLinkedFiles || fileId === 'every';
        const neededFiles = [...openFiles].filter(([id]) => (needsEveryFile || id === fileId) && !openedFileIds.has(id));
        queue.unshift(...neededFiles.flatMap(listSetup));

        return neededFiles.length > 0;
    }

    function listSetup([fileId, { name, setup }]: [number, OpenFile]): QueuedCall[] {
        // doesn't try a file again that a new worker can't open, because a later worker would fail the same way
        function lose(cause: unknown) {
            if (openFiles.delete(fileId)) {
                lostFiles.set(fileId, new EngineError(`The engine couldn't open ${name} again after a restart.`, { cause }));
            }
        }

        return setup.map(({ method, args }) => ({
            method,
            args,
            fileId,
            isSetup: true,
            resolve(reply) {
                if (reply.error === undefined) {
                    openedFileIds.add(fileId);
                } else {
                    lose(new Error(reply.error));
                }
            },
            reject: lose,
        }));
    }

    function keepSetup(method: keyof Engine, args: unknown[]) {
        const [fileId] = args as [number];
        if (method === 'open') {
            openFiles.set(fileId, { name: String(args[1]), setup: [] });
            openedFileIds.add(fileId);
        }
        if (method === 'open' || method === 'provide') {
            openFiles.get(fileId)?.setup.push({ method, args });
        }
    }

    function finishRunning(): QueuedCall | undefined {
        const finished = runningCall;
        runningCall = undefined;
        clearTimeout(timeLimitTimer);
        stopCancelLimit();

        return finished;
    }

    function rejectCalls(calls: QueuedCall[], error: unknown) {
        for (const queued of calls) {
            if (queued.method === 'close') {
                // queues a close again because a close without a worker resolves
                queue.push(queued);
            } else {
                queued.reject(error);
            }
        }
    }

    function fail(error: unknown) {
        const failed = finishRunning();
        stop();
        rejectCalls(failed ? [failed] : queue.splice(0), error);
        sendNext();
    }

    // stops a worker whose canceled call keeps the waiting calls from running, because a call in wasm can't see the
    // cancel
    function startCancelLimit() {
        if (runningCall?.isCanceled && queue.length > 0 && cancelLimitTimer === undefined) {
            cancelLimitTimer = setTimeout(() => {
                finishRunning();
                stop();
                sendNext();
            }, options.cancelLimitMs);
        }
    }

    function stopCancelLimit() {
        clearTimeout(cancelLimitTimer);
        cancelLimitTimer = undefined;
    }

    // lets the worker's later reply to a canceled running call only start the next call because the call already
    // rejected
    function cancel(canceled: QueuedCall) {
        const index = queue.indexOf(canceled);
        canceled.isCanceled = true;
        if (index >= 0) {
            queue.splice(index, 1);
            if (queue.length === 0) {
                stopCancelLimit();
            }

            sendNext();
        } else if (runningCall === canceled) {
            worker?.postMessage({ cancel: true } satisfies WorkerRequest);
            startCancelLimit();
        } else if (sideCall?.call === canceled) {
            worker?.postMessage({ cancel: true, id: sideCall.id } satisfies WorkerRequest);
        }
    }

    function call<Value>(method: keyof Engine, args: unknown[], signal?: AbortSignal): Promise<Value> {
        const replied = new Promise<Reply<unknown>>((resolve, reject) => {
            if (signal?.aborted) {
                reject(new CanceledError('The call was canceled.'));
                return;
            }

            function abort() {
                reject(new CanceledError('The call was canceled.'));
                cancel(queued);
            }
            const queued: QueuedCall = {
                method,
                args,
                fileId: findFileId(method, args),
                resolve(reply) {
                    signal?.removeEventListener('abort', abort);
                    if (reply.error === undefined) {
                        keepSetup(method, args);
                    }

                    resolve(reply);
                },
                reject(error) {
                    signal?.removeEventListener('abort', abort);
                    reject(error);
                },
            };
            signal?.addEventListener('abort', abort, { once: true });
            queue.push(queued);
            sendNext();
            startCancelLimit();
        });

        return replied.then(unwrap).then(value => readReplyValue(method, value)) as Promise<Value>;
    }

    return {
        claims: (name, file) => call('claims', [name, file]),
        async open(name, file) {
            const fileId = nextFileId++;
            await call('open', [fileId, name, file]);

            return fileId;
        },
        close: fileId => call('close', [fileId]),
        provide: (fileId, name, file) => call('provide', [fileId, name, file]),
        list: fileId => call('list', [fileId]),
        read: (fileId, key, view, signal) => call('read', [fileId, key, view], signal),
        describe: (target, view, signal) => call('describe', [target, view], signal),
        resolve: (target, signal) => call('resolve', [target], signal),
        findReferences: (target, view, signal) => call('findReferences', [target, view], signal),
        listStrings: fileId => call('listStrings', [fileId]),
    };
}
