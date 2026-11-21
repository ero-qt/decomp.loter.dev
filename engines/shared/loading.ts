import { failed, type Reply } from '../../contract/reply';
import type { EngineHandlers } from '../../contract/serve';

/** An error of a part that an engine loads, like a chunk that didn't load, which a handler refuses its call with. */
export class LoadError extends Error {}

function readMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Returns the function that runs the load with its first call and gives the same load after that. Forgets a failed
 * load, so the next call loads again, because the connection can come back.
 */
export function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
    let loading: Promise<T> | undefined;

    return () => {
        loading ??= load().catch((error: unknown) => {
            loading = undefined;
            throw error;
        });

        return loading;
    };
}

/**
 * Turns the load errors that the handlers throw into failed replies, because the worker stays usable after them and a
 * later call can load the part that failed to load.
 */
export function refuseLoadErrors(handlers: EngineHandlers): EngineHandlers {
    const calls = Object.entries(handlers as unknown as Record<string, (...args: never[]) => Promise<Reply<unknown>>>);
    const refusing = calls.map(([name, handler]) => {
        async function refuse(...args: never[]): Promise<Reply<unknown>> {
            try {
                return await handler(...args);
            } catch (error) {
                if (error instanceof LoadError) {
                    return failed(error.message);
                }

                throw error;
            }
        }

        return [name, refuse];
    });

    return Object.fromEntries(refusing) as unknown as EngineHandlers;
}

/** Fetches a file's bytes, or throws a load error with the engine's name, like `native`, and what it couldn't load. */
export async function fetchBytes(url: URL, what: string, engineName: string): Promise<Uint8Array> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }

        return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
        throw new LoadError(`The ${engineName} engine couldn't load ${what}: ${readMessage(error)}`);
    }
}

/**
 * Imports a module by its URL at run time, because a bundle then leaves the module out, or throws a load error with
 * the engine's name and what it couldn't load.
 */
export async function importModule<T>(url: string, what: string, engineName: string): Promise<T> {
    try {
        return await import(url);
    } catch (error) {
        throw new LoadError(`The ${engineName} engine couldn't load ${what}: ${readMessage(error)}`);
    }
}
