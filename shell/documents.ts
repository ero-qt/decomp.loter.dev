import { formatTarget, parseTarget } from '#contract/document';
import type { View } from '#contract/manifest';
import { CanceledError } from '#contract/reply';
import { findDocumentRow, type Row } from '#contract/rows';
import { kinds } from '#contract/symbols';
import type {
    CancellationToken,
    DocumentSemanticTokensProvider,
    Position,
    Range,
    Tab,
    TextDocument,
    TextDocumentContentProvider,
    Uri,
} from 'vscode';
import { vscode } from './api';
import { documentScheme, symbolsViewId } from './config';
import { formatDocumentPath, parseDocumentPath } from './document-paths';
import type { SiteEngine } from './engines';
import { type OpenFile, type OpenFiles, type ReadDocument, readErrorText } from './files';
import { createPositionFinder } from './lines';
import { findRowIndex } from './rows';
import { findDeclarations, readTokenModifiers } from './tokens';

// waits before it reads a document that the engine wrote in part again, because the workbench drops a change of a
// document that it still opens
const readAgainDelayMs = 100;

// falls back to the first view for a row that every view hides
function pickView(views: View[], { hiddenViews }: Row, viewId?: string): View {
    const shows = (index: number) => (hiddenViews & (1 << index)) === 0;

    return views.find((view, index) => view.id === viewId && shows(index)) ?? views.find((_, index) => shows(index)) ?? views[0];
}

function readTabUri(tab: Tab): Uri | undefined {
    return tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined;
}

// rejects at once when the signal aborts because a caller that gives up doesn't wait for the end of a read that others
// share
function untilAborted<Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new CanceledError('The read was canceled.'));
        signal?.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    });
}

function listTabs(): Tab[] {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs);
}

interface DocumentRead {
    read: Promise<ReadDocument>;
    controller: AbortController;
    /** The count of callers that wait for the read and that `forget` doesn't cancel the read for. */
    waiters: number;
    /** Whether the document closed, so nobody shows the read's text. */
    isClosed: boolean;
}

/**
 * Serves each row's document to the workbench as a read-only document, colors the document with the engine's tokens and
 * closes a file's tabs after the file closes.
 */
export class RowDocuments implements TextDocumentContentProvider, DocumentSemanticTokensProvider {
    // document's URI -> the document's read
    private readonly documents = new Map<string, DocumentRead>();
    private readonly changedDocument = new vscode.EventEmitter<Uri>();
    private readonly changedTokens = new vscode.EventEmitter<void>();
    private clickCount = 0;
    private isDoubleClick = false;
    private pendingReads = 0;
    private endProgress = () => {};
    readonly onDidChange = this.changedDocument.event;
    readonly onDidChangeSemanticTokens = this.changedTokens.event;

    constructor(private readonly openFiles: OpenFiles) {
        openFiles.onDidChange(file => this.dropDocuments(file));
        vscode.workspace.onDidCloseTextDocument(document => this.forget(document.uri.toString(), true));
        vscode.window.tabGroups.onDidChangeTabs(({ closed }) => {
            const shownUris = new Set(listTabs().map(tab => readTabUri(tab)?.toString()));
            for (const uri of closed.map(readTabUri)) {
                if (uri && !shownUris.has(uri.toString())) {
                    this.forget(uri.toString(), true);
                }
            }
        });
        // watches the page's double-clicks because the Symbols view runs a row's command alike for a click and a
        // double-click, and leaves out the twistie because a double-click there doesn't run the command
        window.addEventListener('dblclick', ({ target }) => {
            const element = target instanceof Element ? target : undefined;
            const isOnRow = Boolean(element?.closest('[role=tree][aria-label=Symbols] [role=treeitem]'));
            this.isDoubleClick = isOnRow && !element?.closest('.monaco-tl-twistie');
        }, { capture: true });
        window.addEventListener('pointerdown', () => this.isDoubleClick = false, { capture: true });
    }

    /** Finds the open file, the view's id and the document row's key of a document, or `undefined` without an open file. */
    findDocument(uri: Uri): { file: OpenFile; viewId: string; key: number } | undefined {
        const path = parseDocumentPath(uri.path);
        const file = this.openFiles.files.find(file => {
            return file.siteEngine?.manifest.id === path?.engineId && file.fileId === path?.fileId;
        });

        return file && path && { file, viewId: path.viewId, key: path.key };
    }

    private start(uri: Uri): DocumentRead {
        let document = this.documents.get(uri.toString());
        if (!document) {
            const found = this.findDocument(uri);
            const controller = new AbortController();
            const read = found
                ? this.openFiles.read(found.file, found.key, found.viewId, controller.signal)
                : Promise.reject(new Error(`the page doesn't have an open file for '${uri.path}'`));
            const started: DocumentRead = { read, controller, waiters: 0, isClosed: false };
            this.documents.set(uri.toString(), started);
            this.followRead(read, uri, started);
            document = started;
        }

        return document;
    }

    // reads a document that the engine wrote in part again, because the engine writes the rest meanwhile, unless the
    // document closed or changed, with the read started before the workbench asks for the document, so the progress
    // strip runs on from read to read
    private readAgain(uri: Uri, document: DocumentRead) {
        if (this.documents.get(uri.toString()) === document && !document.isClosed) {
            this.forget(uri.toString());
            this.start(uri);
            this.changedDocument.fire(uri);
        }
    }

    // runs the Symbols view's progress strip while any read is pending, because the page doesn't open a document's tab
    // before the document's read ends, and until the next read of a document that the engine wrote in part starts
    private followRead(read: Promise<ReadDocument>, uri: Uri, document: DocumentRead) {
        if (this.pendingReads++ === 0) {
            const { promise, resolve } = Promise.withResolvers<void>();
            this.endProgress = resolve;
            void vscode.window.withProgress({ location: { viewId: symbolsViewId } }, () => promise);
        }

        const end = () => {
            if (--this.pendingReads === 0) {
                this.endProgress();
            }
        };
        void read.then(({ isPartial }) => {
            if (!isPartial) {
                end();
                return;
            }

            setTimeout(() => {
                this.readAgain(uri, document);
                end();
            }, readAgainDelayMs);
        }, end);
    }

    // drops a document's read, so the next caller reads the document again
    private forget(uri: string, isClosed = false) {
        const document = this.documents.get(uri);
        if (document) {
            this.documents.delete(uri);
            document.isClosed = isClosed;
            this.cancelUnwaited(uri, document);
        }
    }

    // cancels a dropped read that no caller waits for because the engine would otherwise keep writing a document that
    // nobody shows
    private cancelUnwaited(uri: string, document: DocumentRead) {
        if (document.waiters === 0 && this.documents.get(uri) !== document) {
            document.controller.abort();
        }
    }

    // waits for a document's read until the signal aborts, and reads the document again when a dropped read got
    // canceled because the caller still needs the document
    private async wait(uri: Uri, signal?: AbortSignal): Promise<ReadDocument> {
        for (;;) {
            if (signal?.aborted) {
                throw new CanceledError('The read was canceled.');
            }

            const document = this.start(uri);
            document.waiters++;
            try {
                return await untilAborted(document.read, signal);
            } catch (error) {
                if (!(error instanceof CanceledError) || signal?.aborted) {
                    throw error;
                }
            } finally {
                document.waiters--;
                this.cancelUnwaited(uri.toString(), document);
            }
        }
    }

    /**
     * Reads a document with the document's open file, view id and document row's key until the signal aborts, or
     * returns `undefined` for a document without an open file or with a failed read, whose error goes to
     * `handleFailure`. The read stays until the document closes or the file changes, or until the end of
     * `searchDocuments` for a document without a tab.
     */
    async readOpenDocument(
        uri: Uri,
        handleFailure: (error: unknown) => void = () => undefined,
        signal?: AbortSignal,
    ): Promise<{ file: OpenFile; viewId: string; key: number; read: ReadDocument } | undefined> {
        const found = this.findDocument(uri);
        const read = found && (await this.wait(uri, signal).catch(handleFailure));

        return found && read ? { ...found, read } : undefined;
    }

    // drops a failed document and refreshes a document without a read because the workbench keeps a document's text
    // after its tab closes
    private async refreshDocument(uri: Uri) {
        const document = this.documents.get(uri.toString());
        if (!document || !(await document.read.then(() => true, () => false))) {
            this.forget(uri.toString());
            this.changedDocument.fire(uri);
        }
    }

    // drops the closed files' documents and refreshes the documents of the changed file and of a linked engine's files
    // because a provided file or another open file can change the documents
    private dropDocuments(changed: OpenFile) {
        const { siteEngine } = changed;
        const closedFileTabs = listTabs().filter(tab => {
            const uri = readTabUri(tab);

            return uri?.scheme === documentScheme && !this.findDocument(uri);
        });
        void vscode.window.tabGroups.close(closedFileTabs);
        // copies the keys because a fired change reads the document again at once and puts its key back into the map
        for (const key of [...this.documents.keys()]) {
            const uri = vscode.Uri.parse(key);
            const found = this.findDocument(uri);
            if (!found) {
                this.forget(key);
            } else if (found.file === changed || (siteEngine?.manifest.hasLinkedFiles && found.file.siteEngine === siteEngine)) {
                this.forget(key);
                this.changedDocument.fire(uri);
            }
        }

        this.changedTokens.fire();
    }

    // reads the document again after a canceled read because the workbench would show an empty text until the next read
    async provideTextDocumentContent(uri: Uri): Promise<string> {
        for (;;) {
            const document = this.start(uri);
            try {
                return (await document.read).text;
            } catch (error) {
                if (!(error instanceof CanceledError)) {
                    return readErrorText(error, 'The engine crashed while it wrote the document.');
                }
                if (document.isClosed) {
                    return '';
                }
            }
        }
    }

    // fires a change of the tokens after a drop cancels the read of a document that's still open, because the workbench
    // keeps the empty tokens until the next change
    // doesn't return tokens for a failed document because the document's text already shows the error
    async provideDocumentSemanticTokens(document: TextDocument) {
        const builder = new vscode.SemanticTokensBuilder();
        const documentRead = this.start(document.uri);
        const { tokens } = await documentRead.read.catch((error: unknown) => {
            if (error instanceof CanceledError && !documentRead.isClosed) {
                this.changedTokens.fire();
            }

            return { tokens: [] };
        });
        for (const { start, length, kind, flags } of tokens) {
            const { line, character } = document.positionAt(start);
            builder.push(line, character, length, kinds.indexOf(kind), readTokenModifiers(flags));
        }

        return builder.build();
    }

    private async findTargetRow(siteEngine: SiteEngine, target: string): Promise<{ fileId: number; rows: Row[]; index: number } | undefined> {
        const parsed = parseTarget(target);
        if (!('fileId' in parsed)) {
            return undefined;
        }

        const file = this.openFiles.files.find(file => file.siteEngine === siteEngine && file.fileId === parsed.fileId);
        if (!file) {
            return undefined;
        }

        const { rows } = await this.openFiles.list(file);

        return { fileId: parsed.fileId, rows, index: findRowIndex(rows, parsed.key) };
    }

    /**
     * Finds the URI of the document that shows a row target's row. The document is in the view with the id, or in the
     * engine's first view that doesn't hide the document row when the engine doesn't have a view with the id or the
     * view hides the document row.
     */
    async findDocumentUri(siteEngine: SiteEngine, target: string, viewId?: string): Promise<Uri | undefined> {
        const found = await this.findTargetRow(siteEngine, target);
        const documentRow = found && found.rows[findDocumentRow(found.rows, found.index) ?? -1];
        if (!found || !documentRow) {
            return undefined;
        }

        const { id: engineId, views } = siteEngine.manifest;
        const view = pickView(views, documentRow, viewId);
        const parts = { engineId, viewId: view.id, fileId: found.fileId, key: documentRow.key };

        return vscode.Uri.from({ scheme: documentScheme, path: formatDocumentPath(parts, documentRow.name, view.extension) });
    }

    /**
     * Reads a document like `readOpenDocument` after dropping a failed read, because the engine's next read can
     * succeed.
     */
    async readAgainIfFailed(uri: Uri, handleFailure?: (error: unknown) => void, signal?: AbortSignal) {
        await this.refreshDocument(uri);

        return this.readOpenDocument(uri, handleFailure, signal);
    }

    /**
     * Finds the document that shows a row target's row like `findDocumentUri`, the position of the row's declaration
     * and the declaration's range. The document is in the engine's first view that doesn't hide the row when the view
     * with the id hides the row.
     */
    async locate(siteEngine: SiteEngine, target: string, viewId?: string): Promise<{ uri: Uri; position: Position; range: Range } | undefined> {
        const found = await this.findTargetRow(siteEngine, target);
        const row = found?.rows[found.index];
        const uri = row && (await this.findDocumentUri(siteEngine, target, pickView(siteEngine.manifest.views, row, viewId).id));
        if (!uri) {
            return undefined;
        }

        await this.refreshDocument(uri);
        const document = await this.wait(uri).catch(() => undefined);
        const declaration = document && findDeclarations(document.tokens).get(target);

        const { line, character } = createPositionFinder(document?.text ?? '')(declaration?.start ?? 0);
        const position = new vscode.Position(line, character);

        return { uri, position, range: new vscode.Range(position, position.translate(0, declaration?.length ?? 0)) };
    }

    /**
     * Runs a search through documents and then drops the reads that the search added for documents without a tab, also
     * at once when the workbench cancels the search, which cancels the reads that still run.
     */
    async searchDocuments<Result>(search: () => Promise<Result>, cancellation: CancellationToken): Promise<Result> {
        const keptUris = new Set(this.documents.keys());
        const dropAddedReads = () => {
            const shownUris = new Set(listTabs().map(tab => readTabUri(tab)?.toString()));
            for (const uri of this.documents.keys()) {
                if (!keptUris.has(uri) && !shownUris.has(uri)) {
                    this.forget(uri);
                }
            }
        };
        const listener = cancellation.onCancellationRequested(dropAddedReads);
        try {
            return await search();
        } finally {
            listener.dispose();
            dropAddedReads();
        }
    }

    /**
     * Opens the document that shows a row, in the first view of the file's engine, with the cursor at the row's
     * declaration. The document opens in the preview tab, or in a kept tab after a double-click on the row.
     */
    async show(file: OpenFile, row: Row) {
        const click = ++this.clickCount;
        const preview = !this.isDoubleClick;
        this.isDoubleClick = false;
        const located = await this.locate(file.siteEngine!, formatTarget({ fileId: file.fileId!, key: row.key }));
        // shows nothing after a later click or after the file's close because the tab then belongs to the later click
        // or to no document
        if (located && click === this.clickCount && this.openFiles.files.includes(file)) {
            const selection = new vscode.Range(located.position, located.position);
            await vscode.window.showTextDocument(located.uri, { selection, preview });
        }
    }

    /**
     * Opens the document that shows a row target's row in a view, in another editor group that already has the document
     * or else in the group beside the active group, with the cursor at the row's declaration and the focus in the
     * active group.
     */
    async showBeside(siteEngine: SiteEngine, target: string, viewId: string) {
        const located = await this.locate(siteEngine, target, viewId);
        // shows nothing after the file's close because the tab then belongs to no document
        if (located && this.findDocument(located.uri)) {
            const group = vscode.window.tabGroups.all.find(group => {
                return !group.isActive && group.tabs.some(tab => readTabUri(tab)?.toString() === located.uri.toString());
            });
            const selection = new vscode.Range(located.position, located.position);
            const viewColumn = group?.viewColumn ?? vscode.ViewColumn.Beside;
            await vscode.window.showTextDocument(located.uri, { viewColumn, preserveFocus: true, selection });
        }
    }
}
