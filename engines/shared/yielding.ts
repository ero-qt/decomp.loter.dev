/**
 * Returns the function that a long loop awaits between its steps. It gives the worker's message loop a turn once the
 * last turn is `everyMs` ago, because the worker only sees a cancel message in its turn, and throws once the signal
 * aborted.
 */
export function createYielder(signal: AbortSignal, everyMs = 50): () => Promise<void> {
    let lastTurn = performance.now();

    return async () => {
        if (performance.now() - lastTurn >= everyMs) {
            await new Promise(resolve => setTimeout(resolve));
            lastTurn = performance.now();
        }

        signal.throwIfAborted();
    };
}
