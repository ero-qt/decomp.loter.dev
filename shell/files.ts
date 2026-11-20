import type { Listing } from '../contract/engine';
import { EngineError } from '../contract/reply';
import { readRows, type Row, type Rows } from '../contract/rows';
import { vscode } from './api';
import { findEngine, type SiteEngine } from './engines';
import type { PickedFile } from './picking';

/** A file's listing with the engine's values read into rows. */
export interface ReadListing extends Omit<Listing, keyof Rows> {
    rows: Row[];
}

/** A file that the user opened and that an engine claimed. */
export interface OpenFile {
    picked: PickedFile;
    /** The engine that claimed the file, or `undefined` for a file whose `claims` call failed. */
    siteEngine?: SiteEngine;
    /** The file's id in the engine, or `undefined` for a file that the engine couldn't open. */
    fileId?: number;
    /** The text of the error that stopped the file's opening. */
    errorText?: string;
    listing?: Promise<ReadListing>;
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

/** Keeps the open files, each in the engine that claimed the file, and the files' listings. */
export class OpenFiles {
    // file's path -> the open file
    private readonly filesByPath = new Map<string, OpenFile>();
    private opening = Promise.resolve();
    private readonly changed = new vscode.EventEmitter<void>();
    /** Fires after a file opens or closes. */
    readonly onDidChange = this.changed.event;

    constructor(private readonly engines: SiteEngine[]) {}

    get files(): OpenFile[] {
        return [...this.filesByPath.values()];
    }

    /**
     * Opens each picked file that an engine claims in place of the open file with the same path. The files open one
     * after another, also across calls, so a file picked twice replaces the file that opened first.
     */
    open(pickedFiles: PickedFile[]): Promise<void> {
        const opened = this.opening.then(async () => {
            for (const picked of pickedFiles) {
                await this.openFile(picked);
            }
        });
        this.opening = opened.catch(() => undefined);

        return opened;
    }

    private async openFile(picked: PickedFile) {
        const file: OpenFile = { picked };
        try {
            file.siteEngine = await findEngine(this.engines, picked.file);
            if (!file.siteEngine) {
                return;
            }

            await this.close(this.filesByPath.get(picked.path));
            file.fileId = await file.siteEngine.engine.open(picked.file.name, picked.file);
        } catch (error) {
            await this.close(this.filesByPath.get(picked.path));
            file.errorText = readErrorText(error, 'The engine crashed while it opened the file.');
        }

        this.filesByPath.set(picked.path, file);
        this.change(file);
    }

    /** Closes a file in the file's engine and removes the file. */
    async close(file: OpenFile | undefined) {
        if (!file || this.filesByPath.get(file.picked.path) !== file) {
            return;
        }

        this.filesByPath.delete(file.picked.path);
        this.change(file);
        if (file.fileId !== undefined) {
            await file.siteEngine!.engine.close(file.fileId);
        }
    }

    // drops the listings of the engine's files because a file's missing files can change with the engine's open files
    private change({ siteEngine }: OpenFile) {
        for (const file of this.filesByPath.values()) {
            if (siteEngine?.manifest.hasLinkedFiles && file.siteEngine === siteEngine) {
                file.listing = undefined;
            }
        }

        this.changed.fire();
    }

    /** Lists an open file's rows once and keeps the listing until the file's engine drops it, but not a failed listing. */
    list(file: OpenFile): Promise<ReadListing> {
        if (!file.listing) {
            const listing = file.siteEngine!.engine.list(file.fileId!).then(({ note, missingFiles, ...rows }) => {
                return { note, missingFiles, rows: readRows(rows) };
            });
            file.listing = listing;
            listing.catch(() => {
                if (file.listing === listing) {
                    file.listing = undefined;
                }
            });
        }

        return file.listing;
    }
}
