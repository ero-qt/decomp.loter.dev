import { formatTarget, parseTarget, type Target } from '#contract/document';
import type { StringUse } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { findDocumentRow, type Row } from '#contract/rows';
import type { CancellationToken, WorkspaceSymbolProvider } from 'vscode';
import { vscode } from './api';
import { documentScheme } from './config';
import type { RowDocuments } from './documents';
import type { OpenFile, OpenFiles } from './files';
import { pickMatches } from './matches';
import { symbolKinds } from './rows';

const maxResults = 500;

/** A file's rows and strings for a search, with each string's parsed user. */
interface ListedFile {
    file: OpenFile;
    rows: Row[];
    strings: { string: StringUse; user?: Target }[];
    /** Each row's index by the row's key, made on the first string whose user is in the file. */
    indexes?: Map<number, number>;
}

/**
 * A row or a string that a search can find, with the index of the row or of the string's user row and the result's
 * name.
 */
interface Candidate {
    file: OpenFile;
    rows: Row[];
    index: number;
    text: string;
    string?: StringUse;
}

// escapes `$(` because the workbench shows `$(name)` in a result's name as the icon with the name
function escapeIcons(text: string): string {
    return text.replaceAll('$(', '\\$(');
}

function isOpenable({ rows, index }: Candidate): boolean {
    return findDocumentRow(rows, index) !== undefined;
}

/**
 * A search result with the target and the string's text that `resolveWorkspaceSymbol` takes to open the result's
 * document.
 */
class SearchResult extends vscode.SymbolInformation {
    readonly file: OpenFile;
    readonly target: string;
    readonly stringText?: string;

    constructor({ file, rows, index, text, string }: Candidate) {
        const row = rows[index];
        const container = string ? row.name : (rows[row.parent]?.name ?? '');
        const kind = string ? vscode.SymbolKind.String : vscode.SymbolKind[symbolKinds[row.kind]];
        // puts the open file's path into the URI until the result opens because the workbench shows the URI's path next
        // to the result
        const uri = vscode.Uri.from({ scheme: documentScheme, path: file.picked.path });
        // gives each result its own line because the workbench merges the results with the same name, kind, URI and
        // range
        const location = new vscode.Location(uri, new vscode.Position(index, 0));
        super(text, kind, escapeIcons(container), location);
        this.file = file;
        this.target = formatTarget({ fileId: file.fileId!, key: row.key });
        this.stringText = string?.text;
    }
}

/**
 * Finds the open files' symbols by name and the strings in the files' code by text for Go to Symbol in Workspace, and
 * opens a result's document at the symbol's declaration or at the string.
 */
export class SymbolSearch implements WorkspaceSymbolProvider<SearchResult> {
    constructor(private readonly openFiles: OpenFiles, private readonly documents: RowDocuments) {}

    // leaves out a file whose listing fails because the Symbols view shows the failure on the file's row
    private async listFile(file: OpenFile): Promise<ListedFile[]> {
        let rows: Row[];
        try {
            ({ rows } = await this.openFiles.list(file));
        } catch {
            return [];
        }

        try {
            const strings = (await this.openFiles.listStrings(file)).map(string => {
                return { string, user: string.user === null ? undefined : parseTarget(string.user) };
            });

            return [{ file, rows, strings }];
        } catch (error) {
            // keeps a file's names in the search after the file's `listStrings` call fails because the rows don't
            // depend on the strings
            if (!(error instanceof EngineError)) {
                console.error(error);
            }

            return [{ file, rows, strings: [] }];
        }
    }

    // leaves out a string without a user row in an open file of the engine because the string's result doesn't have a
    // document
    private findStrings({ file, strings }: ListedFile, listedFiles: ListedFile[]): Candidate[] {
        return strings.flatMap(({ string, user }) => {
            if (!user || !('fileId' in user)) {
                return [];
            }

            const userFile = listedFiles.find(listed => listed.file.siteEngine === file.siteEngine && listed.file.fileId === user.fileId);
            const index = userFile && (userFile.indexes ??= new Map(userFile.rows.map((row, index) => [row.key, index]))).get(user.key);
            const text = escapeIcons(JSON.stringify(string.text));

            return userFile && index !== undefined ? [{ file: userFile.file, rows: userFile.rows, index, text, string }] : [];
        });
    }

    async provideWorkspaceSymbols(query: string, token: CancellationToken): Promise<SearchResult[]> {
        const files = this.openFiles.files.filter(file => file.fileId !== undefined);
        // skips the listings for a blank query because the workbench searches with an empty query when Go to Symbol in
        // Workspace opens
        const listedFiles = query.trim() === '' ? [] : (await Promise.all(files.map(file => this.listFile(file)))).flat();
        if (token.isCancellationRequested) {
            return [];
        }

        // leaves out the rows that the first view hides because the Symbols view leaves them out too
        const names = listedFiles.flatMap(({ file, rows }) => {
            return rows.flatMap((row, index) => (row.hiddenViews & 1 ? [] : [{ file, rows, index, text: escapeIcons(row.name) }]));
        });
        const strings = listedFiles.flatMap(listed => this.findStrings(listed, listedFiles));
        // only searches the strings for a query that starts with a quote because only a string's name starts with a
        // quote
        const candidates = [
            ...(query.trimStart().startsWith('"') ? [] : pickMatches(names.filter(isOpenable), query, maxResults)),
            ...pickMatches(strings.filter(isOpenable), query, maxResults),
        ];

        return candidates.map(candidate => new SearchResult(candidate));
    }

    async resolveWorkspaceSymbol(result: SearchResult): Promise<SearchResult | undefined> {
        const located = await this.documents.locate(result.file.siteEngine!, result.target);
        // leaves the result of a closed file pending because the workbench opens a result that resolves, also to
        // `undefined`
        if (!located) {
            return new Promise(() => {});
        }

        let position = located.position;
        if (result.stringText !== undefined) {
            const document = await vscode.workspace.openTextDocument(located.uri);
            // puts the cursor on the string's text after the user's declaration because a document's tokens don't mark
            // strings
            const offset = document.getText().indexOf(result.stringText, document.offsetAt(position));
            position = offset < 0 ? position : document.positionAt(offset);
        }

        // sets `external` to the document's URI because the workbench opens the `external` that it kept from the
        // result's first URI
        const uri = Object.assign(located.uri, { external: located.uri.toString() });
        result.location = new vscode.Location(uri, position);

        return result;
    }
}
