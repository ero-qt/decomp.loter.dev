import { formatTarget, parseTarget, type Target } from '#contract/document';
import type { StringUse } from '#contract/engine';
import { EngineError } from '#contract/reply';
import { findDocumentRow, type Row } from '#contract/rows';
import type { CancellationToken, WorkspaceSymbolProvider } from 'vscode';
import { vscode } from './api';
import { findRowIndex, listNames } from './candidates';
import { documentScheme } from './config';
import type { RowDocuments } from './documents';
import type { OpenFile, OpenFiles } from './files';
import { scoreMatches, sortMatches } from './matches';
import { symbolKinds } from './rows';

const maxResults = 500;

/** A string for a search, with its parsed user and its name in the results. */
interface ListedString {
    string: StringUse;
    user?: Target;
    text: string;
}

/** A file's rows and strings for a search. */
interface ListedFile {
    file: OpenFile;
    rows: Row[];
    strings: ListedString[];
}

/**
 * A row or a string that a search can find, with the index of the row or of the string's user row and the result's
 * name.
 */
export interface Candidate {
    file: OpenFile;
    rows: Row[];
    index: number;
    text: string;
    string?: StringUse;
}

// a file's strings -> the strings for a search, because a search runs on each key that the user types
const listedStrings = new WeakMap<StringUse[], ListedString[]>();

// escapes `$(` because the workbench shows `$(name)` in a result's name as the icon with the name
export function escapeIcons(text: string): string {
    return text.replaceAll('$(', '\\$(');
}

/** Lists a file's strings for a search once, each with its parsed user and its text in quotes. */
export function listStrings(strings: StringUse[]): ListedString[] {
    let listed = listedStrings.get(strings);
    if (!listed) {
        listed = strings.map(string => {
            const user = string.user === null ? undefined : parseTarget(string.user);

            return { string, user, text: escapeIcons(JSON.stringify(string.text)) };
        });
        listedStrings.set(strings, listed);
    }

    return listed;
}

/**
 * Finds the place that a search result opens at: the declaration of the result's row, or the string's text after the
 * declaration of the string's user. Returns `undefined` for a result whose file closed.
 */
export async function locateCandidate(documents: RowDocuments, file: OpenFile, target: string, stringText?: string) {
    const located = await documents.locate(file.siteEngine!, target);
    if (!located || stringText === undefined) {
        return located;
    }

    const document = await vscode.workspace.openTextDocument(located.uri);
    // puts the cursor on the string's text after the user's declaration because a document's tokens don't mark strings
    const offset = document.getText().indexOf(stringText, document.offsetAt(located.position));

    return { ...located, position: offset < 0 ? located.position : document.positionAt(offset) };
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
            return [{ file, rows, strings: listStrings(await this.openFiles.listStrings(file)) }];
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
    private findString({ file }: ListedFile, { string, user, text }: ListedString, listedFiles: ListedFile[]): Candidate | undefined {
        if (!user || !('fileId' in user)) {
            return undefined;
        }

        const userFile = listedFiles.find(listed => listed.file.siteEngine === file.siteEngine && listed.file.fileId === user.fileId);
        const index = userFile && findRowIndex(userFile.rows, user.key);
        const isOpenable = userFile && index !== undefined && findDocumentRow(userFile.rows, index) !== undefined;

        return isOpenable ? { file: userFile.file, rows: userFile.rows, index, text, string } : undefined;
    }

    async provideWorkspaceSymbols(query: string, token: CancellationToken): Promise<SearchResult[]> {
        const files = this.openFiles.files.filter(file => file.fileId !== undefined);
        // skips the listings for a blank query because the workbench searches with an empty query when Go to Symbol in
        // Workspace opens
        const listedFiles = query.trim() === '' ? [] : (await Promise.all(files.map(file => this.listFile(file)))).flat();
        if (token.isCancellationRequested) {
            return [];
        }

        // only searches the names for a query that doesn't start with a quote because only a string's name starts with
        // a quote
        const names = query.trimStart().startsWith('"') ? [] : listedFiles.flatMap(({ file, rows }) => {
            return scoreMatches(listNames(rows), query).map(({ item, score }) => ({ item: { file, rows, ...item }, score }));
        });
        const strings = listedFiles.flatMap(listed => {
            return scoreMatches(listed.strings, query).map(({ item, score }) => ({ item: { listed, item }, score }));
        });
        // finds the user of the best strings only, because a file has up to 50,000 strings
        const foundStrings: Candidate[] = [];
        for (const { item } of sortMatches(strings)) {
            const found = foundStrings.length < maxResults && this.findString(item.listed, item.item, listedFiles);
            if (found) {
                foundStrings.push(found);
            }
        }

        const foundNames = sortMatches(names).slice(0, maxResults).map(({ item }) => ({ ...item, text: escapeIcons(item.text) }));
        const candidates = [...foundNames, ...foundStrings];

        return candidates.map(candidate => new SearchResult(candidate));
    }

    async resolveWorkspaceSymbol(result: SearchResult): Promise<SearchResult | undefined> {
        const located = await locateCandidate(this.documents, result.file, result.target, result.stringText);
        // leaves the result of a closed file pending because the workbench opens a result that resolves, also to
        // `undefined`
        if (!located) {
            return new Promise(() => {});
        }

        // sets `external` to the document's URI because the workbench opens the `external` that it kept from the
        // result's first URI
        const uri = Object.assign(located.uri, { external: located.uri.toString() });
        result.location = new vscode.Location(uri, located.position);

        return result;
    }
}
