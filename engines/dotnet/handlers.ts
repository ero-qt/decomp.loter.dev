import type { Document } from '../../contract/document';
import type { Description, Listing, StringUse } from '../../contract/engine';
import { failed, ok, type Reply } from '../../contract/reply';
import type { EngineHandlers } from '../../contract/serve';
import { LoadError, loadOnce, refuseLoadErrors } from '../shared/loading';
import { hasCliHeader } from '../shared/pe';
import { createRefusals } from '../shared/refusals';
import manifest from './manifest.json' with { type: 'json' };
import { readInt32s, readReply, readVoidReply } from './replies';
import type { DotnetExports, DotnetRuntime } from './runtime';

// the views whose documents the engine writes
const views = manifest.views.map(view => view.id);
// the largest file that the engine opens, because the decompiler keeps the whole file in wasm memory and its type
// system takes a few times the file's size there
const maxFileBytes = 256 * 1024 * 1024;
const refusals = createRefusals('.NET');

// the listing as the C# export writes it, with the values in base64
type ListingReply = Omit<Listing, 'values'> & { values: string };

// the document as the C# export writes it, with the tokens in base64
type DocumentReply = Omit<Document, 'tokens'> & { tokens: string };

/**
 * Returns the .NET engine's handlers, which load the runtime with the first call that needs it, because `claims` then
 * only reads the file's headers. The handlers start with an empty runtime because `dotnet.js` loads once in a process.
 */
export function createDotnetHandlers(loadRuntime: () => Promise<DotnetRuntime>): EngineHandlers {
    // turns a failed load into a load error, which the handlers refuse their call with
    const loadEmptyRuntime = loadOnce(async () => {
        const loaded = await loadRuntime().catch((error: unknown) => {
            throw new LoadError(`The .NET engine couldn't load its runtime: ${error instanceof Error ? error.message : error}`);
        });
        loaded.exports.Reset();

        return loaded;
    });

    async function useExports() {
        return (await loadEmptyRuntime()).exports;
    }

    // cancels the export's call once the signal aborts, which the call sees at its next check, and throws the abort's
    // error for a call that stopped after the abort
    async function callExport(signal: AbortSignal, call: (exports: DotnetExports) => Promise<string>): Promise<string> {
        const exports = await useExports();
        signal.throwIfAborted();

        const cancel = () => exports.Cancel();
        signal.addEventListener('abort', cancel);
        try {
            return await call(exports);
        } catch (error) {
            signal.throwIfAborted();
            throw error;
        } finally {
            signal.removeEventListener('abort', cancel);
        }
    }

    return refuseLoadErrors({
        async claims(_, file) {
            return ok(await hasCliHeader(file));
        },
        async open(fileId, name, file) {
            if (file.size > maxFileBytes) {
                return refusals.largeFile(name, maxFileBytes);
            }

            const exports = await useExports();

            return readVoidReply(exports.Open(fileId, name, await file.bytes()));
        },
        async close(fileId) {
            return readVoidReply((await useExports()).Close(fileId));
        },
        provide() {
            return failed("The .NET engine doesn't take other files.");
        },
        async list(fileId, signal) {
            const reply = readReply<ListingReply>(await callExport(signal, exports => exports.List(fileId)));
            if (reply.error !== undefined) {
                return reply;
            }

            return ok({ ...reply.value, values: readInt32s(reply.value.values) });
        },
        async read(fileId, key, view, signal) {
            if (!views.includes(view)) {
                return refusals.view(view);
            }

            const reply = readReply<DocumentReply>(await callExport(signal, exports => {
                return view === 'il' ? exports.ReadIl(fileId, key) : exports.ReadCSharp(fileId, key);
            }));
            if (reply.error !== undefined) {
                return reply;
            }

            return ok({ ...reply.value, tokens: readInt32s(reply.value.tokens) });
        },
        async describe(target, view) {
            if (!views.includes(view)) {
                return refusals.view(view);
            }

            return readReply<Description | null>((await useExports()).Describe(target, view));
        },
        async resolve(target) {
            return readReply<string | null>((await useExports()).Resolve(target));
        },
        // leaves the places of the uses to the page, which finds them in the users' documents, because the engine would
        // decompile each user for them in a call that can't be canceled
        async findReferences(target, view, signal) {
            if (!views.includes(view)) {
                return refusals.view(view);
            }

            const reply = readReply<string[]>(await callExport(signal, exports => exports.FindUsers(target)));
            if (reply.error !== undefined) {
                return reply;
            }

            return ok(reply.value.map(user => ({ user, ranges: null })));
        },
        async listStrings(fileId, signal) {
            return readReply<StringUse[]>(await callExport(signal, exports => exports.ListStrings(fileId)));
        },
    });
}
