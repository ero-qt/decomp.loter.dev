import { type Document, readTokens, type Token } from '../contract/document';
import type { Listing, StringUse } from '../contract/engine';
import { EngineError } from '../contract/reply';
import { readRows, type Row, type Rows } from '../contract/rows';
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
     * that no engine claims. The files open one after another, also across calls, so a file picked twice replaces the
     * file that opened first.
     */
    open(pickedFiles: PickedFile[]): Promise<PickedFile[]> {
        return this.enqueue(async () => {
            const unclaimed: PickedFile[] = [];
            for (const picked of pickedFiles) {
                if (!(await this.openFile(picked))) {
                    unclaimed.push(picked);
                }
            }

            return unclaimed;
        });
    }

    // runs the work after the earlier calls' work because a file picked twice opens in the order of the picks
    private enqueue<Result>(work: () => Promise<Result>): Promise<Result> {
        const done = this.queued.then(work);
        this.queued = done.then(() => undefined, () => undefined);

        return done;
    }

    // only returns false when no engine claims the file because the callers return an unclaimed file for a warning
    private async openFile(picked: PickedFile): Promise<boolean> {
        const file: OpenFile = { picked };
        try {
            file.siteEngine = await findEngine(this.engines, picked.file);
            if (!file.siteEngine) {
                return false;
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

        return true;
    }

    /**
     * Gives the file that the user picked for an open file's missing companion file to the engine's `provide` call
     * under the missing file's name because the user can pick a file with another name, like `app_v2.pdb` for the
     * missing file `app.pdb`. Opens any other picked missing file and returns `false` when no engine claims the picked
     * file. Keeps the text of a failed `provide` call's error in the open file's `errorText` until the next `provide`
     * call succeeds.
     */
    load(file: OpenFile, name: string, picked: PickedFile): Promise<boolean> {
        return this.enqueue(async () => {
            if (this.filesByPath.get(file.picked.path) !== file) {
                return true;
            }

            const listing = await this.list(file).catch(() => undefined);
            if (!listing?.missingFiles.some(missingFile => missingFile.name === name && missingFile.isCompanion)) {
                return this.openFile(picked);
            }

            try {
                await file.siteEngine!.engine.provide(file.fileId!, name, picked.file);
                file.errorText = undefined;
            } catch (error) {
                file.errorText = readErrorText(error, 'The engine crashed while it added the file.');
            }

            this.change(file);

            return true;
        });
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
            const { note, missingFiles, ...rows } = await file.siteEngine!.engine.list(file.fileId!);

            return { note, missingFiles, rows: readRows(rows) };
        });
    }

    /** Lists an open file's strings once and keeps them like `list` keeps the listing. */
    listStrings(file: OpenFile): Promise<StringUse[]> {
        return this.keep(file, 'strings', () => file.siteEngine!.engine.listStrings(file.fileId!));
    }

    /** Reads the document of an open file's row in a view until the signal aborts. */
    async read(file: OpenFile, key: number, viewId: string, signal?: AbortSignal): Promise<ReadDocument> {
        const engineDocument = await file.siteEngine!.engine.read(file.fileId!, key, viewId, signal);

        return { text: engineDocument.text, tokens: readTokens(engineDocument), locals: engineDocument.locals };
    }
}
