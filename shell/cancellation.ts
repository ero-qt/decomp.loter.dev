import type { CancellationToken } from 'vscode';

/** Returns a signal that aborts when the workbench cancels the token, for the engine call of a workbench request. */
export function toSignal(token: CancellationToken): AbortSignal {
    if (token.isCancellationRequested) {
        return AbortSignal.abort();
    }

    const controller = new AbortController();
    const listener = token.onCancellationRequested(() => {
        listener.dispose();
        controller.abort();
    });

    return controller.signal;
}
