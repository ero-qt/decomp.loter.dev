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
import { type BodyPlace, type BodyReader, createBodyReader, type CreateNativeHandlers, insertBodies, type NativeGame } from './bodies';
import { type BodyLinker, createBodyLinker } from './body-links';
import type { Game, GameImage, GameType } from './game';
import { readGameReply } from './game-reader';
import { checkMetadata } from './header';
import manifest from './manifest.json' with { type: 'json' };
import { writeNativeNames } from './names-file';
import { countMemberStarts, firstKeys, listRows, type MemberStarts, readBinaryKey } from './rows';
import type { Il2CppRuntime } from './runtime';
import { indexSharers, noteSharers, type Sharer } from './shared-code';

// the magic 0xfab11baf at the start of global-metadata.dat, in the file's little-endian byte order
const metadataStart = 'af1bb1fa';
// the largest file that the engine opens, because LibCpp2IL keeps the whole file in wasm memory beside its tables
const maxFileBytes = 512 * 1024 * 1024;
const refusals = createRefusals('IL2CPP');
// the assembly with the game's own scripts, whose methods the background decompiles ahead of the framework's
const gameAssembly = 'Assembly-CSharp.dll';
// the body of a method whose C a read didn't wait for, which the page reads again, indented like the C's own lines
const pendingBody = { text: '    // The native engine is still decompiling this method…', tokens: [], locals: [] };
// the views whose documents the engine writes
const views = manifest.views.map(view => view.id);

// the binary that goes with the metadata, under the file names of a Windows build and of an Android or Linux build
const binaryFile = {
    name: 'GameAssembly.dll',
    otherNames: ['libil2cpp.so'],
    reason: 'not loaded, or libil2cpp.so on Android and Linux',
    isCompanion: true,
};

// the document as the C# export writes it, with the tokens in base64 and the key of each method with an empty body
// before the start of the line of the body's `}`
type DocumentReply = Omit<Document, 'tokens'> & { tokens: string; bodies: number[] };

/** An open `global-metadata.dat` file with the game that the engine read from it and, once given, its binary. */
interface OpenFile {
    name: string;
    game: Game;
    rows: Row[];
    rowsByKey: Map<number, Row>;
    starts: MemberStarts;
    /** The binary that `provide` got. */
    nativeGame?: { binaryName: string; binary: Blob };
    /** Whether the binary is a 32-bit ARM ELF file, whose methods' addresses have bit 0 set for Thumb code. */
    isThumb?: boolean;
    /** The assembly of the type that a read opened last, whose methods the background decompiles. */
    backgroundImage?: GameImage;
    /** The stub that a read wrote last, because the page reads a type again while its bodies come. */
    stub?: { typeIndex: number; written: DocumentReply };
    /** The functions that link the tokens of the bodies and of the binary's own C, once a read needs them. */
    linker?: BodyLinker;
    /** The methods that share their code with other methods by the code's address, once a read needs them. */
    sharers?: Map<number, Sharer[]>;
}

// reads the rows of a game and the lookups that reads and descriptions use, with a row for the game's binary once the
// game has it
function listGame(game: Game, binaryName?: string) {
    const rows = listRows(game);
    if (binaryName !== undefined) {
        rows.push({ kind: 'resource', flags: 0, parent: -1, key: firstKeys.binary, name: binaryName, detail: '', hiddenViews: 0 });
    }

    return { game, rows, rowsByKey: new Map(rows.map(row => [row.key, row])), starts: countMemberStarts(game) };
}

// checks for a 32-bit ARM ELF file by its class and its machine, EM_ARM in the little-endian e_machine at offset 18
function isArm32Elf(bytes: Uint8Array): boolean {
    return bytes.length > 19 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[4] === 1 && bytes[18] === 40 && bytes[19] === 0;
}

// returns the address of a method's code, without bit 0, which marks Thumb code in a 32-bit ARM binary, because the
// native engine's functions start at the even address
function findCode(file: OpenFile, rva: number): number {
    return file.isThumb ? rva - (rva & 1) : rva;
}

// lists the addresses of the code of a type's methods, without the accessors of an auto-property, which has the
// compiler's backing field, because the stub writes them as `{ get; set; }`
function listShownCode(file: OpenFile, type: GameType): number[] {
    const fields = new Set(type.fields.map(field => field.name));
    const autoProperties = type.properties.filter(property => fields.has(`<${property.name}>k__BackingField`));
    const autoAccessors = new Set(autoProperties.flatMap(({ getter, setter }) => [getter, setter]));

    return type.methods.flatMap(({ rva }, index) => (rva === null || autoAccessors.has(index) ? [] : [findCode(file, rva)]));
}

function writeNote({ game, nativeGame }: OpenFile): string {
    if (!nativeGame) {
        return 'names only';
    }

    return game.isLayoutGuessed ? `metadata ${game.layout}, guessed among the layouts of version ${game.fileVersion}` : `metadata ${game.layout}`;
}

function useLinker(fileId: number, file: OpenFile): BodyLinker {
    file.linker ??= createBodyLinker(fileId, file, rva => findCode(file, rva));

    return file.linker;
}

// returns the binary of a file with the functions that write its names and link its bodies
function useNativeGame(fileId: number, file: OpenFile): NativeGame | undefined {
    const { nativeGame } = file;
    if (!nativeGame) {
        return undefined;
    }

    return {
        ...nativeGame,
        writeNames: () => writeNativeNames(file.game, rva => findCode(file, rva)),
        link: lines => useLinker(fileId, file).link(lines),
    };
}

/**
 * Returns the IL2CPP engine's handlers, which load the runtime with the first call that needs it, because `claims`
 * then only reads the file's magic. The handlers start with an empty runtime because `dotnet.js` loads once in a
 * process. A type's methods get the C of their code from the native engine as their bodies when the caller gives native
 * handlers.
 */
export function createIl2CppHandlers(loadRuntime: () => Promise<Il2CppRuntime>, createNativeHandlers?: CreateNativeHandlers): EngineHandlers {
    const files = new Map<number, OpenFile>();
    const bodyReader: BodyReader | undefined = createNativeHandlers && createBodyReader(createNativeHandlers);

    // decompiles the methods of the open type's assembly and of the game's own scripts in the background, while the
    // file stays open, because the methods of the whole game take hours and more memory than the worker has
    function startBackground(fileId: number, file: OpenFile, typeIndex = -1) {
        const nativeGame = bodyReader && files.get(fileId) === file ? useNativeGame(fileId, file) : undefined;
        const { images } = file.game;
        const opened = images.find(image => typeIndex >= image.firstType && typeIndex < image.firstType + image.typeCount);
        if (!nativeGame || (opened && opened === file.backgroundImage)) {
            return;
        }

        file.backgroundImage = opened;
        const chosen = new Set([opened, images.find(image => image.name === gameAssembly)]);
        const types = [...chosen].flatMap(image => (image ? file.game.types.slice(image.firstType, image.firstType + image.typeCount) : []));
        bodyReader!.readInBackground(fileId, nativeGame, types.flatMap(type => listShownCode(file, type)));
    }

    // turns a failed load into a load error, which the handlers refuse their call with
    const loadEmptyRuntime = loadOnce(async () => {
        const loaded = await loadRuntime().catch((error: unknown) => {
            throw new LoadError(`The IL2CPP engine couldn't load its runtime: ${error instanceof Error ? error.message : error}`);
        });
        loaded.exports.Reset();

        return loaded;
    });

    // reads the binary's own C of a function that isn't a method, or the note of a global's data, in the view of the
    // documents of symbols without rows
    async function readBinary(fileId: number, file: OpenFile, rva: number, view: string, signal: AbortSignal) {
        const nativeGame = bodyReader && useNativeGame(fileId, file);
        if (!nativeGame) {
            return refusals.key(file.name, `0x${rva.toString(16)}`);
        }
        if (view !== manifest.unlistedView.id) {
            return refusals.view(view);
        }

        const document = await bodyReader!.readAddress(fileId, nativeGame, rva, signal);

        return document.error === undefined ? ok(useLinker(fileId, file).linkDocument(document.value)) : document;
    }

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
            bodyReader?.close(fileId);
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

            bodyReader?.close(fileId);
            const provided: OpenFile = {
                name: file.name,
                ...listGame(reply.value, name),
                nativeGame: { binaryName: name, binary },
                isThumb: isArm32Elf(bytes),
            };
            files.set(fileId, provided);
            // starts after the reply, because the binary's open with its names takes a while
            setTimeout(() => startBackground(fileId, provided));

            return ok(undefined);
        },
        list(fileId) {
            const file = files.get(fileId);
            if (!file) {
                return refusals.file(fileId);
            }

            return ok({ ...writeRows(file.rows), note: writeNote(file), missingFiles: file.nativeGame ? [] : [binaryFile] });
        },
        async read(fileId, key, view, signal) {
            const file = files.get(fileId);
            if (!file) {
                return refusals.file(fileId);
            }

            const rva = readBinaryKey(key);
            if (rva !== undefined) {
                return readBinary(fileId, file, rva, view, signal);
            }

            const reply = findDocumentRowReply(file, key, view, views, refusals);
            if (reply.error !== undefined) {
                return reply;
            }

            const typeIndex = reply.value.key;
            const nativeGame = bodyReader && useNativeGame(fileId, file);
            const { exports } = await loadEmptyRuntime();
            const kept = file.stub?.typeIndex === typeIndex ? ok(file.stub.written) : undefined;
            const written = kept ?? readReply<DocumentReply>(exports.ReadCSharp(fileId, typeIndex, nativeGame !== undefined));
            if (written.error !== undefined) {
                return written;
            }

            file.stub = { typeIndex, written: written.value };
            const document = { ...written.value, tokens: readInt32s(written.value.tokens) };
            if (!nativeGame) {
                return ok(document);
            }

            // only decompiles the methods whose bodies the stub has, which leaves out an auto-property's accessors
            const methods = file.game.types[typeIndex].methods;
            const emptyBodies: { key: number; offset: number; code: number }[] = [];
            for (let index = 0; index < written.value.bodies.length; index += 2) {
                const key = written.value.bodies[index];
                const rva = methods[key - firstKeys.method - file.starts.methods[typeIndex]]?.rva;
                if (rva !== null && rva !== undefined) {
                    emptyBodies.push({ key, offset: written.value.bodies[index + 1], code: findCode(file, rva) });
                }
            }

            const rvas = emptyBodies.map(body => body.code);
            const { bodies, isPartial } = await bodyReader!.readBodies(fileId, nativeGame, rvas, signal);
            startBackground(fileId, file, typeIndex);
            const places: BodyPlace[] = [];
            file.sharers ??= indexSharers(file.game, file.starts, rva => findCode(file, rva));
            for (const { key, offset, code } of emptyBodies) {
                const lines = bodies.has(code) ? bodies.get(code) : pendingBody;
                const others = file.sharers.get(code)?.filter(sharer => sharer.key !== key);
                if (lines) {
                    places.push({ offset, lines: others ? noteSharers(lines, others, fileId) : lines });
                }
            }

            return ok({ ...insertBodies(document, places, target => target), isPartial });
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

            if (row.kind === 'section' || row.kind === 'namespace' || row.kind === 'resource') {
                return ok({ text: row.kind === 'namespace' ? `namespace ${row.name}` : row.name, container: null, facts: [], missingFile: null });
            }

            const { exports } = await loadEmptyRuntime();

            return readReply<Description | null>(exports.Describe(parsed.fileId, row.key));
        },
        resolve(target) {
            const parsed = parseTarget(target);
            const file = 'fileId' in parsed ? files.get(parsed.fileId) : undefined;
            // reads the C of a function or a global of the binary, which doesn't have a row, once the engine has the binary
            const hasBinary = file?.nativeGame !== undefined && bodyReader !== undefined;
            const isInBinary = 'key' in parsed && readBinaryKey(parsed.key) !== undefined && hasBinary;

            return ok(file && 'key' in parsed && (isInBinary || file.rowsByKey.has(parsed.key)) ? target : null);
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
