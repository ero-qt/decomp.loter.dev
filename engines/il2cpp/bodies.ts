import { type Document, readTokens, type Token, writeTokens } from '#contract/document';
import { type EmbeddedLines, indentLines, moveByLines, placeTokens, sliceBody } from '#contract/embedding';
import { failed, type Reply } from '#contract/reply';
import type { NativeHandlers } from '../native/handlers';
import type { NativeNames } from './names-file';

/** The game's binary and the names that the native engine decompiles the methods' code with. */
export interface NativeGame {
    binaryName: string;
    binary: Blob;
    /** Writes the names with the binary's open, like `writeNativeNames`, because they take a while for a large game. */
    writeNames(): NativeNames;
    /** Gives the tokens of a body their targets in the game once after its decompile, like `createBodyLinker`. */
    link(lines: EmbeddedLines): EmbeddedLines;
}

/** Reads the C of methods' code from the native engine, which runs in the same worker. */
export interface BodyReader {
    /**
     * Returns the body of the C of the code at each address relative to the image, with the native engine's tokens
     * and targets, or a comment with the reason for an address whose code the native engine doesn't decompile. Waits
     * half a second at most, because a type with thousands of methods takes minutes, and not at all before the binary
     * opened. The bodies then leave out the addresses that still wait, with `isPartial` set. The addresses go ahead of
     * the background's addresses. Throws after the signal aborts.
     */
    readBodies(fileId: number, game: NativeGame, rvas: number[], signal: AbortSignal): Promise<ReadBodies>;
    /**
     * Reads the binary's own C of the code at an address relative to the image, or the note of the data there, with
     * the native engine's tokens and targets, like a function of the runtime that a body calls. Opens the binary first
     * when no body did.
     */
    readAddress(fileId: number, game: NativeGame, rva: number, signal: AbortSignal): Promise<Reply<Document>>;
    /** Decompiles the code at each address in the background, one address at a time while no read waits. */
    readInBackground(fileId: number, game: NativeGame, rvas: number[]): void;
    /** Stops the file's background work and drops its bodies. */
    close(fileId: number): void;
}

/** The bodies that a read got by their addresses, and whether others still wait. */
export interface ReadBodies {
    bodies: Map<number, EmbeddedLines>;
    isPartial: boolean;
}

/** Returns a set of native engine handlers, which the worker loads by a dynamic import with the first read. */
export type CreateNativeHandlers = () => NativeHandlers | Promise<NativeHandlers>;

/** A file's open binary, its bodies by their addresses and the addresses that wait in the background. */
interface FileBodies {
    game: NativeGame;
    /** Stops the file's work on its close, because a decompile outlives the read that started it. */
    controller: AbortController;
    /** The open of the binary with its names, which gives the native engine's refusal of the binary, if any. */
    open?: Promise<string | undefined>;
    /** Whether the open ended, before which a read doesn't wait, because the open blocks the worker for seconds. */
    isOpen?: boolean;
    /** The names that the open loaded, which write the structs of each body's code before its decompile. */
    names?: NativeNames;
    /** The bodies by their addresses, the body read longest ago first. */
    bodies: Map<number, Promise<EmbeddedLines>>;
    /** The length of the text of each body that came, which counts toward `maxKeptChars`. */
    sizes: Map<number, number>;
    keptChars: number;
    /** The start of each body whose decompile waits in a queue. */
    waiting: Map<number, PromiseWithResolvers<EmbeddedLines>>;
    background: number[];
    /** The index of the background's next address. */
    next: number;
}

// the time that a read waits for its bodies before it replies with the bodies that came
const partialWaitMs = 500;
// the text of the bodies that a file keeps, about 32 MB in UTF-16, because the worker's memory limit doesn't count it
const defaultMaxKeptChars = 16 * 1024 * 1024;

/** A decompile that waits in a queue, which a decompile that started earlier makes stale. */
interface Entry {
    fileId: number;
    file: FileBodies;
    rva: number;
}

// waits for a promise until the signal aborts, which leaves the work behind the promise running
function waitUntilAborted<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

// gives the worker's message loop a turn with a timer, which takes its turn with the page's messages, from a message's
// task, because a timer that a timer's task sets waits 4 ms after the 5th
function yieldTurn(): Promise<void> {
    const { port1, port2 } = new MessageChannel();

    return new Promise(resolve => {
        port1.onmessage = () => {
            port1.close();
            setTimeout(resolve);
        };
        port2.postMessage(undefined);
    });
}

/**
 * Returns the reader of methods' C, which opens the game's binary in a set of native handlers with the first
 * decompile of a file and keeps each body that it read. A file whose binary the native engine refuses gets no bodies.
 * The decompiles run one at a time, a read's addresses first, and give the worker's message loop a turn in between,
 * so a read that comes in goes ahead of the background. The addresses of a read that stops before its bodies go
 * behind the next read's addresses.
 */
export function createBodyReader(createNativeHandlers: CreateNativeHandlers, maxKeptChars = defaultMaxKeptChars): BodyReader {
    let native: NativeHandlers | undefined;
    const files = new Map<number, FileBodies>();
    // the decompiles that reads wait for, which go before the decompiles that stopped reads left
    const urgent: Entry[] = [];
    const left: Entry[] = [];
    // the close of each file's binary, which waits for the binary's open
    const closes = new Map<number, Promise<unknown>>();
    let isRunning = false;

    // opens the binary and loads its names, without which the C still has the binary's own names
    async function openBinary(fileId: number, file: FileBodies): Promise<string | undefined> {
        native ??= await createNativeHandlers();
        await closes.get(fileId);
        const opened = await native.open(fileId, file.game.binaryName, file.game.binary, file.controller.signal);
        if (opened.error !== undefined) {
            return opened.error;
        }

        file.names = file.game.writeNames();
        await native.loadNames(fileId, file.names.lines, new Blob());

        return undefined;
    }

    // loads the structs and globals that the C of the code at an address needs, the structs of its own signature and of
    // the methods and globals that it refers to
    async function loadTypes(fileId: number, file: FileBodies, rva: number) {
        const targets = await native!.listCodeTargets(fileId, rva);
        const types = file.names?.writeTypes([rva, ...(targets.value ?? [])]);
        if (types && (types.header || types.globals)) {
            await native!.loadTypes(fileId, new Blob([types.header]), new Blob([types.globals]));
        }
    }

    // decompiles the code at an address, or writes why the native engine doesn't as the body's comment, indented like
    // the C's own lines, because an empty body reads like an empty method
    async function decompile(fileId: number, file: FileBodies, rva: number): Promise<EmbeddedLines> {
        file.open ??= openBinary(fileId, file).finally(() => (file.isOpen = true));
        const refusal = await file.open;
        file.controller.signal.throwIfAborted();
        if (refusal === undefined) {
            await loadTypes(fileId, file, rva);
        }

        const document = refusal === undefined ? await native!.readCode(fileId, rva, file.controller.signal, true) : failed(refusal);
        const body = document.error === undefined ? sliceBody(document.value) : undefined;

        const reason = document.error ?? "The native engine's C of the method doesn't have a body.";

        return body ? file.game.link(body) : { text: `    // ${reason}`, tokens: [], locals: [] };
    }

    // returns the body at an address, which waits for its decompile in a queue, or the body that the file has, which
    // then counts as read last
    function useBody(file: FileBodies, rva: number): Promise<EmbeddedLines> {
        const kept = file.bodies.get(rva);
        if (kept) {
            file.bodies.delete(rva);
            file.bodies.set(rva, kept);

            return kept;
        }

        const started = Promise.withResolvers<EmbeddedLines>();
        file.bodies.set(rva, started.promise);
        file.waiting.set(rva, started);
        // forgets a decompile that the file's close stopped, so nothing keeps its error
        started.promise.catch(() => file.bodies.delete(rva));

        return started.promise;
    }

    // starts an entry's decompile, or returns `undefined` for a stale entry and an entry of a closed file
    function start({ fileId, file, rva }: Entry): Promise<void> | undefined {
        const started = file.waiting.get(rva);
        if (!started || files.get(fileId) !== file) {
            return undefined;
        }

        file.waiting.delete(rva);

        return decompile(fileId, file, rva).then(lines => {
            keep(file, rva, lines.text.length);
            started.resolve(lines);
        }, started.reject);
    }

    // counts a body that came and drops the bodies read longest ago while the kept text passes `maxKeptChars`
    function keep(file: FileBodies, rva: number, size: number) {
        file.sizes.set(rva, size);
        file.keptChars += size;
        for (const kept of file.bodies.keys()) {
            if (file.keptChars <= maxKeptChars) {
                break;
            }

            const keptSize = file.sizes.get(kept);
            if (keptSize !== undefined && kept !== rva) {
                file.bodies.delete(kept);
                file.sizes.delete(kept);
                file.keptChars -= keptSize;
            }
        }
    }

    // takes the next address of a file's background that doesn't have a body yet
    function takeBackground(): Entry | undefined {
        for (const [fileId, file] of files) {
            while (file.next < file.background.length) {
                const rva = file.background[file.next++];
                if (!file.bodies.has(rva)) {
                    void useBody(file, rva);

                    return { fileId, file, rva };
                }
            }
        }

        return undefined;
    }

    function takeNext(): Entry | undefined {
        return urgent.shift() ?? left.shift() ?? takeBackground();
    }

    // runs 1 decompile at a time, a read's first, and gives the message loop a turn after each decompile
    async function run() {
        if (isRunning) {
            return;
        }

        isRunning = true;
        try {
            for (let entry = takeNext(); entry; entry = takeNext()) {
                const work = start(entry);
                if (work) {
                    await work.catch(() => undefined);
                    await yieldTurn();
                }
            }
        } finally {
            isRunning = false;
        }
    }

    // moves the entries of a read that ended out of the urgent queue, ahead of the background
    function leave(entries: Entry[]) {
        const leaving = new Set(entries);
        const stay = urgent.filter(entry => !leaving.has(entry));
        left.unshift(...urgent.filter(entry => leaving.has(entry)));
        urgent.splice(0, urgent.length, ...stay);
    }

    function useFile(fileId: number, game: NativeGame): FileBodies {
        let file = files.get(fileId);
        if (!file) {
            const controller = new AbortController();
            file = { game, controller, bodies: new Map(), sizes: new Map(), keptChars: 0, waiting: new Map(), background: [], next: 0 };
            files.set(fileId, file);
        }

        return file;
    }

    return {
        async readBodies(fileId, game, rvas, signal) {
            const read = new Map<number, EmbeddedLines>();
            const file = useFile(fileId, game);
            const unique = [...new Set(rvas)];
            const bodies = unique.map(rva => useBody(file, rva).then(lines => void read.set(rva, lines)));
            const entries = unique.filter(rva => file.waiting.has(rva)).map(rva => ({ fileId, file, rva }));
            urgent.push(...entries);
            void run();

            const waited = Promise.withResolvers<void>();
            const timer = setTimeout(waited.resolve, file.isOpen ? partialWaitMs : 0);
            try {
                await waitUntilAborted(Promise.race([Promise.all(bodies), waited.promise]), signal);
            } finally {
                clearTimeout(timer);
                leave(entries);
            }

            return { bodies: read, isPartial: read.size < unique.length };
        },
        async readAddress(fileId, game, rva, signal) {
            const file = useFile(fileId, game);
            file.open ??= openBinary(fileId, file).finally(() => (file.isOpen = true));
            const refusal = await waitUntilAborted(file.open, signal);

            return refusal === undefined ? native!.readAddress(fileId, rva, signal) : failed(refusal);
        },
        readInBackground(fileId, game, rvas) {
            const file = useFile(fileId, game);
            file.background = rvas;
            file.next = 0;
            void run();
        },
        close(fileId) {
            const file = files.get(fileId);
            files.delete(fileId);
            file?.controller.abort();
            for (const started of file?.waiting.values() ?? []) {
                started.reject(file!.controller.signal.reason);
            }
            if (file?.open) {
                closes.set(fileId, file.open.catch(() => undefined).then(() => native?.close(fileId, new AbortController().signal)));
            }
        },
    };
}

// writes each run of 4 spaces at a line's start as a tab, like the indentation of the decompiler's C#, with the tokens
// moved along
function useTabs({ text, tokens, locals }: EmbeddedLines): EmbeddedLines {
    const lines = text.split('\n');
    // the start of each line's text after its indentation, in the text and in the text with tabs
    const starts: [from: number, to: number][] = [];
    let from = 0;
    let to = 0;
    const tabbed = lines.map(line => {
        const spaces = /^ */.exec(line)![0].length;
        const written = '\t'.repeat(Math.floor(spaces / 4)) + line.slice(spaces - (spaces % 4));
        const indentation = written.length - (line.length - spaces);
        starts.push([from + spaces, to + indentation]);
        from += line.length + 1;
        to += written.length + 1;

        return written;
    });

    return { text: tabbed.join('\n'), tokens: moveByLines(tokens, starts), locals };
}

/** The C of a method's code with the start of the line of the `}` of the method's empty body in a document. */
export interface BodyPlace {
    offset: number;
    lines: EmbeddedLines;
}

/**
 * Puts the C of methods into their empty bodies in a type's document, with the C's own indentation after the
 * indentation of the body's `}`, and with the C's tokens and locals. Each target of the C becomes the target that
 * `mapTarget` gives, or none.
 */
export function insertBodies(document: Document, places: BodyPlace[], mapTarget: (target: string) => string | null): Document {
    const tokens = readTokens(document).sort((first, second) => first.start - second.start);
    const written: Token[] = [];
    const locals = [...document.locals];
    let text = '';
    let copied = 0;
    let next = 0;

    // copies the document's text and tokens up to an offset of the document
    function copyUntil(offset: number) {
        const segmentStart = text.length;
        text += document.text.slice(copied, offset);
        for (; next < tokens.length && tokens[next].start < offset; next++) {
            written.push({ ...tokens[next], start: tokens[next].start - copied + segmentStart });
        }

        copied = offset;
    }

    for (const { offset, lines } of [...places].sort((first, second) => first.offset - second.offset)) {
        copyUntil(offset);

        const body = indentLines(useTabs(lines), /^[\t ]*/.exec(document.text.slice(offset))![0]);
        written.push(...placeTokens(body, text.length, locals.length, mapTarget));
        locals.push(...body.locals);
        text += `${body.text}\n`;
    }

    copyUntil(document.text.length);

    return writeTokens(text, written, locals);
}
