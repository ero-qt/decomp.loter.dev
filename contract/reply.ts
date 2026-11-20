/** The result of an engine call: its value, or the error text that the page shows. */
export type Reply<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

/** An error with a text for the user, like the error that `unwrap` throws for a failed reply. */
export class EngineError extends Error {}

/** The error of an engine call whose signal aborted, which the page drops because nobody waits for the result. */
export class CanceledError extends Error {}

export function ok<T>(value: T): Reply<T> {
    return { value };
}

export function failed(error: string): Reply<never> {
    return { error };
}

/** Returns the value of a reply, or throws an `EngineError` with its error text. */
export function unwrap<T>(reply: Reply<T>): T {
    if (reply.error !== undefined) {
        throw new EngineError(reply.error);
    }

    return reply.value;
}
