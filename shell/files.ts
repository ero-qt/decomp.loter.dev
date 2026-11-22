import { type Document, readTokens, type Token } from '#contract/document';
import type { Listing, StringUse } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { readRows, type Row, type Rows } from '#contract/rows';
import { vscode } from './api';
import { findEngine, type SiteEngine } from './engines';
import type { PickedFile } from './picking';

/** A file's listing with the engine's values read into rows. */
export interface ReadListing extends Omit<Listing, keyof Rows> {
    rows: Row[];
}

/** A document with the engine's values read into tokens. */
export interface ReadDocument extends Omit<Document, 'tokens' | 'targets'> {
    tokens: Token[];
}

/** A file that the user opened and that an engine claimed. */
export interface OpenFile {
    picked: PickedFile;
    /** The engine that claimed the file, or `undefined` for a file whose `claims` call failed. */
    siteEngine?: SiteEngine;
    /** The file's id in the engine, or `undefined` for a file that the engine couldn't open. */
    fileId?: number;
    /** The text of the error that stopped the file's opening or that the last `provide` call threw. */
    errorText?: string;
    /** The picked files that went to a successful `provide` call by their paths. */
    companions: Map<string, PickedFile>;
    listing?: Promise<ReadListing>;
    strings?: Promise<StringUse[]>;
}

/**
 * Returns an `EngineError`'s text, or logs any other error and returns the crash text, because only an `EngineError`
 * has a text for the user.
 */
export function readErrorText(error: unknown, crashText: string): string {
    if (error instanceof EngineError) {
        return error.message;
    }

    console.error(error);

    return crashText;
}

// the languages whose grammar and TextMate worker already started
const warmedLanguages = new Set<string>();

/**
 * Opens an empty document in each language of the engine's views, once per language, so the workbench fetches the
 * language's grammar and starts the TextMate worker while the engine opens the file, not after the first click.
 */
function warmLanguages(siteEngine: SiteEngine) {
    for (const { language } of siteEngine.manifest.views) {
        if (!warmedLanguages.has(language)) {
            warmedLanguages.add(language);
            void vscode.workspace.openTextDocument({ language, content: '' });
        }
    }
}

// returns the folder of a picked file's path, with the last slash, or an empty text for a file without a folder
function readFolder(path: string): string {
    return path.slice(0, path.lastIndexOf('/') + 1);
}

/** Keeps the open files, each in the engine that claimed the file, and the files' listings. */
export class OpenFiles {
    // file's path -> the open file
    private readonly filesByPath = new Map<string, OpenFile>();
    private queued = Promise.resolve();
    private readonly changed = new vscode.EventEmitter<OpenFile>();
    /** Fires with a file after the file opens, closes or gets a file through `load`. */
    readonly onDidChange = this.changed.event;

    constructor(private readonly engines: SiteEngine[]) {}

    get files(): OpenFile[] {
        return [...this.filesByPath.values()];
    }

    /**
     * Opens each picked file that an engine claims in place of the open file with the same path and returns the files
     * that no engine claims and no open file misses. The files open one after another, also across calls, so a file
     * picked twice replaces the file that opened first. A picked file with the name of a missing companion file of a
     * file that opens in the same call also goes to that file's `provide` call, like a game's `GameAssembly.dll` picked
     * with its metadata, and doesn't open as its own file when the file's engine keeps its companions. The files' pairs
     * with files that opened before go out after the call returns because they wait for the files' listings.
     */
    open(pickedFiles: PickedFile[]): Promise<PickedFile[]> {
        const opened = this.enqueue(async () => {
            const files: OpenFile[] = [];
            const unclaimed: PickedFile[] = [];
            const claims = new Map<PickedFile, SiteEngine | Error | undefined>();
            for (const picked of pickedFiles) {
                claims.set(picked, await findEngine(this.engines, picked.file).catch((error: unknown) => error as Error));
            }

            // opens the files whose engine keeps its companions first and gives them their companions among the picked
            // files, which then don't open as their own files
            const isHost = (picked: PickedFile) => {
                const claim = claims.get(picked);

                return !(claim instanceof Error) && claim?.manifest.keepsCompanions === true;
            };
            const hosts = pickedFiles.filter(isHost);
            for (const picked of hosts) {
                files.push((await this.openFile(picked, claims.get(picked)))!);
            }

            const kept = pickedFiles.length > 1 ? await this.pair(files, pickedFiles) : new Set<PickedFile>();
            for (const picked of pickedFiles.filter(picked => !isHost(picked) && !kept.has(picked))) {
                const file = await this.openFile(picked, claims.get(picked));
                if (file) {
                    files.push(file);
                } else {
                    unclaimed.push(picked);
                }
            }

            const others = files.filter(file => !hosts.includes(file.picked));
            const paired = pickedFiles.length > 1 ? await this.pair(others, pickedFiles.filter(picked => !kept.has(picked))) : new Set<PickedFile>();

            return { files, unclaimed: unclaimed.filter(picked => !paired.has(picked)) };
        });
        void opened.then(({ files }) => this.pairWithOpenFiles(files), () => undefined);

        return opened.then(({ unclaimed }) => unclaimed);
    }

    // runs the work after the earlier calls' work because a file picked twice opens in the order of the picks
    private enqueue<Result>(work: () => Promise<Result>): Promise<Result> {
        const done = this.queued.then(work);
        this.queued = done.then(() => undefined, () => undefined);

        return done;
    }

    /**
     * Opens a picked file in the engine that claims it, or in the engine of `claim` that a caller already found, or
     * keeps the error of `claim`. Only returns `undefined` when no engine claims the file because the callers return an
     * unclaimed file for a warning.
     */
    private async openFile(picked: PickedFile, claim?: SiteEngine | Error): Promise<OpenFile | undefined> {
        const file: OpenFile = { picked, companions: new Map() };
        try {
            if (claim instanceof Error) {
                throw claim;
            }

            file.siteEngine = claim ?? (await findEngine(this.engines, picked.file));
            if (!file.siteEngine) {
                return undefined;
            }

            warmLanguages(file.siteEngine);
            await this.close(this.filesByPath.get(picked.path));
            file.fileId = await file.siteEngine.engine.open(picked.file.name, picked.file);
        } catch (error) {
            await this.close(this.filesByPath.get(picked.path));
            file.errorText = readErrorText(error, 'The engine crashed while it opened the file.');
        }

        this.filesByPath.set(picked.path, file);
        this.change(file);

        return file;
    }

    /**
     * Gives the file that the user picked for an open file's missing companion file to the engine's `provide` call
     * under the missing file's name because the user can pick a file with another name, like `app_v2.pdb` for the
     * missing file `app.pdb`. A companion that an engine claims opens as its own file too, unless the file's engine
     * keeps its companions, like the IL2CPP engine a game's `GameAssembly.dll`. Opens any other picked missing file and
     * returns `false` when no engine claims the picked file. Keeps the text of a failed `provide` call's error in the
     * open file's `errorText` until the next `provide` call succeeds.
     */
    load(file: OpenFile, name: string, picked: PickedFile): Promise<boolean> {
        return this.enqueue(async () => {
            if (this.filesByPath.get(file.picked.path) !== file) {
                return true;
            }

            const listing = await this.list(file).catch(() => undefined);
            if (!listing?.missingFiles.some(missingFile => missingFile.name === name && missingFile.isCompanion)) {
                const opened = await this.openFile(picked);
                if (opened) {
                    void this.pairWithOpenFiles([opened]);
                }

                return opened !== undefined;
            }

            await this.provide(file, name, picked);
            const isKept = file.siteEngine!.manifest.keepsCompanions === true;
            if (!isKept && file.companions.get(picked.path) === picked && !this.filesByPath.has(picked.path)) {
                const opened = await this.openFile(picked);
                if (opened) {
                    void this.pairWithOpenFiles([opened]);
                }
            }

            return true;
        });
    }

    // keeps the text of a failed call's error in the file's `errorText` until the next `provide` call succeeds
    private async provide(file: OpenFile, name: string, provided: PickedFile) {
        try {
            await file.siteEngine!.engine.provide(file.fileId!, name, provided.file);
            file.errorText = undefined;
            file.companions.set(provided.path, provided);
        } catch (error) {
            file.errorText = readErrorText(error, 'The engine crashed while it added the file.');
        }

        this.change(file);
    }

    /**
     * Gives each opened file's missing companion file to the file's `provide` call when a picked file has the
     * companion's name. Returns the picked files that went to a `provide` call. Each picked file goes to 1 open file.
     * A picked file from the open file's own folder goes first because a dropped folder can have 2 games, each with a
     * `GameAssembly.dll` beside the game's metadata.
     */
    private async pair(openedFiles: OpenFile[], pickedFiles: PickedFile[]): Promise<Set<PickedFile>> {
        const files = openedFiles.filter(file => file.fileId !== undefined);
        const listings = await Promise.all(files.map(file => this.list(file).catch(() => undefined)));
        const unpaired = new Set(files.flatMap((file, index) => {
            const companions = listings[index]?.missingFiles.filter(missingFile => missingFile.isCompanion) ?? [];

            return companions.map(missingFile => ({ file, names: [missingFile.name, ...(missingFile.otherNames ?? [])] }));
        }));

        const paired = new Set<PickedFile>();
        for (const isSameFolder of [true, false]) {
            for (const wanted of [...unpaired]) {
                const { file, names } = wanted;
                const companion = pickedFiles.find(picked => {
                    const isCandidate = !paired.has(picked) && picked.path !== file.picked.path && names.includes(picked.file.name);

                    return isCandidate && (!isSameFolder || readFolder(picked.path) === readFolder(file.picked.path));
                });
                if (companion) {
                    paired.add(companion);
                    unpaired.delete(wanted);
                    await this.provide(file, companion.file.name, companion);
                }
            }
        }

        return paired;
    }

    /**
     * Pairs the opened files with the files that opened before, like a game's metadata dropped after its
     * `GameAssembly.dll`. An opened file gets an earlier file for a missing companion with the earlier file's name. An
     * earlier file gets an opened file the same way. Each file's listing goes apart from the others because a listing
     * that doesn't come back then only stops the pairs that need the listing.
     */
    private async pairWithOpenFiles(openedFiles: OpenFile[]) {
        const opened = openedFiles.filter(file => file.fileId !== undefined);
        const earlier = this.files.filter(file => file.fileId !== undefined && !openedFiles.includes(file));
        // only lists the files when there's a file to pair with, because a listing can take long
        if (opened.length === 0 || earlier.length === 0) {
            return;
        }

        await Promise.all([...opened.map(file => this.pairWith(file, earlier)), ...earlier.map(file => this.pairWith(file, opened))]);
    }

    // gives 1 file's missing companion files to its `provide` call when another open file from the same folder has a
    // companion's name and isn't another file's companion yet, because a game's metadata dropped later would otherwise
    // get the binary of another game. Closes the companion's own file when the file's engine keeps its companions.
    private async pairWith(file: OpenFile, others: OpenFile[]) {
        const listing = await this.list(file).catch(() => undefined);
        const companions = listing?.missingFiles.filter(missingFile => missingFile.isCompanion) ?? [];
        const isTaken = (other: OpenFile) => this.files.some(owner => owner !== file && owner.companions.has(other.picked.path));

        for (const { name, otherNames = [] } of companions) {
            const companion = others.find(other => {
                const isSameFolder = readFolder(other.picked.path) === readFolder(file.picked.path);

                return isSameFolder && [name, ...otherNames].includes(other.picked.file.name) && !isTaken(other);
            });
            if (companion && this.filesByPath.get(file.picked.path) === file) {
                await this.provide(file, companion.picked.file.name, companion.picked);
                if (file.siteEngine!.manifest.keepsCompanions && file.companions.has(companion.picked.path)) {
                    await this.close(companion);
                }
            }
        }
    }

    // returns the id of a file that its engine opened, or throws the error of the file's open
    private useOpen(file: OpenFile): number {
        if (file.fileId === undefined) {
            throw new EngineError(file.errorText ?? "The engine couldn't open the file.");
        }

        return file.fileId;
    }

    /** Closes a file in the file's engine and removes the file. */
    async close(file: OpenFile | undefined) {
        if (!file || this.filesByPath.get(file.picked.path) !== file) {
            return;
        }

        this.filesByPath.delete(file.picked.path);
        // queues the close before the change because the engine would otherwise read a linked file's document again
        // with the closed file still open
        const closed = file.fileId !== undefined && file.siteEngine!.engine.close(file.fileId);
        this.change(file);
        await closed;
    }

    // drops the listings and strings of the file and of a linked engine's files because a file's missing files and
    // strings change with its engine's open files and with its provided files
    private change(changed: OpenFile) {
        for (const file of this.filesByPath.values()) {
            if (file === changed || (changed.siteEngine?.manifest.hasLinkedFiles && file.siteEngine === changed.siteEngine)) {
                file.listing = undefined;
                file.strings = undefined;
            }
        }

        this.changed.fire(changed);
    }

    // keeps a listing or the strings until the file's engine drops them, but not a failed call, because the next call
    // can succeed
    private keep<Key extends 'listing' | 'strings'>(file: OpenFile, key: Key, start: () => NonNullable<OpenFile[Key]>) {
        if (!file[key]) {
            const started = start();
            file[key] = started;
            started.catch(() => {
                if (file[key] === started) {
                    file[key] = undefined;
                }
            });
        }

        return file[key]!;
    }

    /**
     * Lists an open file's rows once and keeps the listing until the file's engine drops it, but not a failed listing.
     */
    list(file: OpenFile): Promise<ReadListing> {
        return this.keep(file, 'listing', async () => {
            const { note, missingFiles, ...rows } = await file.siteEngine!.engine.list(this.useOpen(file));

            return { note, missingFiles, rows: readRows(rows) };
        });
    }

    /** Lists an open file's strings once and keeps them like `list` keeps the listing. */
    listStrings(file: OpenFile): Promise<StringUse[]> {
        return this.keep(file, 'strings', async () => file.siteEngine!.engine.listStrings(this.useOpen(file)));
    }

    /** Reads the document of an open file's row in a view until the signal aborts. */
    async read(file: OpenFile, key: number, viewId: string, signal?: AbortSignal): Promise<ReadDocument> {
        const engineDocument = await file.siteEngine!.engine.read(file.fileId!, key, viewId, signal);

        return { text: engineDocument.text, tokens: readTokens(engineDocument), locals: engineDocument.locals };
    }
}
