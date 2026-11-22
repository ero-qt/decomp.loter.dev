import { type Document, parseTarget } from '#contract/document';
import type { Description } from '#contract/engine';
import { failed, ok } from '#contract/reply';
import { type Row, writeRows } from '#contract/rows';
import type { EngineHandlers } from '#contract/serve';
import { readInt32s, readReply } from '../dotnet/replies';
import { capStrings } from '../shared/limits';
import { LoadError, loadOnce, refuseLoadErrors } from '../shared/loading';
import { readStartHex } from '../shared/magic';
import { createRefusals, findDocumentRowReply } from '../shared/refusals';
import type { Game } from './game';
import { readGameReply } from './game-reader';
import { checkMetadata } from './header';
import manifest from './manifest.json' with { type: 'json' };
import { listRows } from './rows';
import type { Il2CppRuntime } from './runtime';

// the magic 0xfab11baf at the start of global-metadata.dat, in the file's little-endian byte order
const metadataStart = 'af1bb1fa';
// the largest file that the engine opens, because LibCpp2IL keeps the whole file in wasm memory beside its tables
const maxFileBytes = 512 * 1024 * 1024;
const refusals = createRefusals('IL2CPP');
// the views whose documents the engine writes
const views = manifest.views.map(view => view.id);

// the binary that goes with the metadata, under the file names of a Windows build and of an Android or Linux build
const binaryFile = {
    name: 'GameAssembly.dll',
    otherNames: ['libil2cpp.so'],
    reason: 'not loaded, or libil2cpp.so on Android and Linux',
    isCompanion: true,
};

// the document as the C# export writes it, with the tokens in base64
type DocumentReply = Omit<Document, 'tokens'> & { tokens: string };

/** An open `global-metadata.dat` file with the game that the engine read from it and, once given, its binary. */
interface OpenFile {
    name: string;
    game: Game;
    rows: Row[];
    rowsByKey: Map<number, Row>;
    /** The binary that `provide` got. */
    nativeGame?: { binaryName: string; binary: Blob };
}

// reads the rows of a game and the lookup that descriptions use
function listGame(game: Game) {
    const rows = listRows(game);

    return { game, rows, rowsByKey: new Map(rows.map(row => [row.key, row])) };
}

function writeNote({ game, nativeGame }: OpenFile): string {
    if (!nativeGame) {
        return 'names only';
    }

    return game.isLayoutGuessed ? `metadata ${game.layout}, guessed among the layouts of version ${game.fileVersion}` : `metadata ${game.layout}`;
}

/**
 * Returns the IL2CPP engine's handlers, which load the runtime with the first call that needs it, because `claims`
 * then only reads the file's magic. The handlers start with an empty runtime because `dotnet.js` loads once in a
 * process.
 */
export function createIl2CppHandlers(loadRuntime: () => Promise<Il2CppRuntime>): EngineHandlers {
    const files = new Map<number, OpenFile>();

    // turns a failed load into a load error, which the handlers refuse their call with
    const loadEmptyRuntime = loadOnce(async () => {
        const loaded = await loadRuntime().catch((error: unknown) => {
            throw new LoadError(`The IL2CPP engine couldn't load its runtime: ${error instanceof Error ? error.message : error}`);
        });
        loaded.exports.Reset();

        return loaded;
    });

    return refuseLoadErrors({
        async claims(_, file) {
            return ok(file.size >= 4 && (await readStartHex(file, 4)) === metadataStart);
        },
        async open(fileId, name, file) {
            if (file.size > maxFileBytes) {
                return refusals.largeFile(name, maxFileBytes);
            }

            const bytes = await file.bytes();
            const refusal = checkMetadata(name, bytes);
            if (refusal !== undefined) {
                return failed(refusal);
            }

            const { exports } = await loadEmptyRuntime();
            const reply = readGameReply(exports.ReadMetadata(fileId, name, bytes));
            if (reply.error !== undefined) {
                return reply;
            }

            files.set(fileId, { name, ...listGame(reply.value) });

            return ok(undefined);
        },
        async close(fileId) {
            if (!files.delete(fileId)) {
                return refusals.file(fileId);
            }

            (await loadEmptyRuntime()).exports.Close(fileId);

            return ok(undefined);
        },
        async provide(fileId, name, binary) {
            const file = files.get(fileId);
            if (!file) {
                return refusals.file(fileId);
            }
            if (binary.size > maxFileBytes) {
                return refusals.largeFile(name, maxFileBytes);
            }

            const { exports } = await loadEmptyRuntime();
            const bytes = await binary.bytes();
            const reply = readGameReply(exports.ReadGame(fileId, file.name, name, bytes));
            if (reply.error !== undefined) {
                return reply;
            }

            files.set(fileId, { name: file.name, ...listGame(reply.value), nativeGame: { binaryName: name, binary } });

            return ok(undefined);
        },
        list(fileId) {
            const file = files.get(fileId);
            if (!file) {
                return refusals.file(fileId);
            }

            return ok({ ...writeRows(file.rows), note: writeNote(file), missingFiles: file.nativeGame ? [] : [binaryFile] });
        },
        async read(fileId, key, view) {
            const file = files.get(fileId);
            if (!file) {
                return refusals.file(fileId);
            }

            const reply = findDocumentRowReply(file, key, view, views, refusals);
            if (reply.error !== undefined) {
                return reply;
            }

            const { exports } = await loadEmptyRuntime();
            const written = readReply<DocumentReply>(exports.ReadCSharp(fileId, reply.value.key, false));
            if (written.error !== undefined) {
                return written;
            }

            return ok({ ...written.value, tokens: readInt32s(written.value.tokens) });
        },
        async describe(target, view) {
            if (!views.includes(view)) {
                return refusals.view(view);
            }

            const parsed = parseTarget(target);
            if (!('key' in parsed)) {
                return ok(null);
            }

            const row = files.get(parsed.fileId)?.rowsByKey.get(parsed.key);
            if (!row) {
                return ok(null);
            }

            if (row.kind === 'section' || row.kind === 'namespace') {
                return ok({ text: row.kind === 'namespace' ? `namespace ${row.name}` : row.name, container: null, facts: [], missingFile: null });
            }

            const { exports } = await loadEmptyRuntime();

            return readReply<Description | null>(exports.Describe(parsed.fileId, row.key));
        },
        resolve(target) {
            const parsed = parseTarget(target);
            const file = 'fileId' in parsed ? files.get(parsed.fileId) : undefined;

            return ok(file && 'key' in parsed && file.rowsByKey.has(parsed.key) ? target : null);
        },
        findReferences(_, view) {
            return views.includes(view) ? ok([]) : refusals.view(view);
        },
        listStrings(fileId) {
            const file = files.get(fileId);

            return file ? ok(capStrings(file.game.strings.map(text => ({ text, user: null })))) : refusals.file(fileId);
        },
    });
}
