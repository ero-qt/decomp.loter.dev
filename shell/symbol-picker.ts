import { formatTarget } from '#contract/document';
import { EngineError } from '#contract/reply';
import { findDocumentRow, type Row } from '#contract/rows';
import type { QuickPickItem } from 'vscode';
import { vscode } from './api';
import { findRowIndex, listNames } from './candidates';
import type { RowDocuments } from './documents';
import type { OpenFile, OpenFiles } from './files';
import { type ScoredMatch, scoreMatches, sortMatches } from './matches';
import { isBlank, isInPlace, matchesRow, parseQuery, type SymbolQuery } from './query';
import { symbolKinds } from './rows';
import { type Candidate, escapeIcons, listStrings, locateCandidate } from './search';

const maxResults = 500;
// the rows that a search checks before it gives the page a turn, so a file of a million rows doesn't block the typing
const rowsPerTurn = 20000;
const placeholder = 'Search symbols by name, with kind:method, is:public or in:file to filter. Start with " to search strings.';

/** A result of the picker, with the row or string that it opens. */
interface ResultItem extends QuickPickItem {
    candidate: Candidate;
}

// keeps the best results of a file after each part, so a short text doesn't keep a million matches
function keepBest(matches: ScoredMatch<Candidate>[]): ScoredMatch<Candidate>[] {
    return matches.length > maxResults ? sortMatches(matches).slice(0, maxResults) : matches;
}

// writes a kind's icon like the workbench's symbol icons, `symbol-enum-member` for the kind `EnumMember`
function findIcon({ rows, index, string }: Candidate): string {
    const name = string ? 'String' : symbolKinds[rows[index].kind];

    return `symbol-${name.replace(/(?<!^)[A-Z]/g, '-$&').toLowerCase()}`;
}

function writeItem(candidate: Candidate): ResultItem {
    const { file, rows, index, text, string } = candidate;
    const row: Row | undefined = rows[index];
    const container = string ? (row?.name ?? 'no known user') : (rows[row.parent]?.name ?? '');
    const description = [escapeIcons(container), file.picked.path].filter(Boolean).join(' • ');

    // shows every item because the picker would else hide the items whose name doesn't have the whole query, filters
    // included
    const iconPath = new vscode.ThemeIcon(findIcon(candidate));

    return { label: string ? text : escapeIcons(text), description, iconPath, alwaysShow: true, candidate };
}

/**
 * Shows a picker that finds the open files' symbols by name and the strings of their code by text, with the filters of
 * `parseQuery`, and opens the picked result's document at the symbol or the string. Shows each file's results once the
 * file is searched, so a slow file doesn't hold back the others.
 */
export class SymbolPicker {
    constructor(private readonly openFiles: OpenFiles, private readonly documents: RowDocuments) {}

    show() {
        const picker = vscode.window.createQuickPick<ResultItem>();
        let searchCount = 0;

        picker.placeholder = placeholder;
        // keeps the items in the order of their scores, which the picker would else sort by their names. The API's
        // types leave the property out
        (picker as unknown as { sortByLabel: boolean }).sortByLabel = false;
        picker.onDidChangeValue(async value => {
            const search = ++searchCount;
            const isStale = () => search !== searchCount;
            const found: ScoredMatch<Candidate>[][] = [];
            picker.busy = true;

            await this.search(parseQuery(value), isStale, (fileIndex, matches) => {
                found[fileIndex] = matches;
                picker.items = sortMatches(found.flat()).slice(0, maxResults).map(({ item }) => writeItem(item));
            });
            if (!isStale()) {
                picker.items = found.length === 0 ? [] : picker.items;
                picker.busy = false;
            }
        });
        picker.onDidAccept(() => {
            const [item] = picker.selectedItems;
            if (item) {
                picker.hide();
                void this.open(item.candidate);
            }
        });
        picker.onDidHide(() => {
            searchCount++;
            picker.dispose();
        });
        picker.show();
    }

    // searches the files side by side and reports each file's matches, in the files' order, unless a later search runs
    private async search(query: SymbolQuery, isStale: () => boolean, report: (fileIndex: number, matches: ScoredMatch<Candidate>[]) => void) {
        const files = isBlank(query) ? [] : this.openFiles.files.filter(file => file.fileId !== undefined);

        await Promise.all(files.map(async (file, fileIndex) => {
            const matches = await (query.isStrings ? this.searchStrings(file, query) : this.searchNames(file, query, isStale));
            if (!isStale()) {
                report(fileIndex, matches);
            }
        }));
    }

    // leaves out a file whose listing fails because the Symbols view shows the failure on the file's row
    private async searchNames(file: OpenFile, query: SymbolQuery, isStale: () => boolean): Promise<ScoredMatch<Candidate>[]> {
        const rows = await this.openFiles.list(file).then(listing => listing.rows, () => undefined);
        const names = rows ? listNames(rows) : [];
        const engineId = file.siteEngine!.manifest.id;
        let matches: ScoredMatch<Candidate>[] = [];

        for (let start = 0; rows && start < names.length && !isStale(); start += rowsPerTurn) {
            if (start > 0) {
                await new Promise(resolve => setTimeout(resolve));
            }

            const filtered = names
                .slice(start, start + rowsPerTurn)
                .filter(({ index }) => matchesRow(query, rows, index) && isInPlace(query, file.picked.path, engineId, rows, index))
                .map(({ index, text }) => ({ file, rows, index, text }));
            const scored = query.text === '' ? filtered.map(item => ({ item, score: 0 })) : scoreMatches(filtered, query.text);
            matches = keepBest([...matches, ...scored]);
        }

        return matches;
    }

    // finds the row of each matching string's user, which can be in another file of the engine, and keeps a string
    // without a known user, like the strings of a game's metadata
    private async searchStrings(file: OpenFile, query: SymbolQuery): Promise<ScoredMatch<Candidate>[]> {
        const matches: ScoredMatch<Candidate>[] = [];
        let strings: ReturnType<typeof listStrings> = [];
        try {
            strings = listStrings(await this.openFiles.listStrings(file));
        } catch (error) {
            // leaves out the strings of a file whose engine refuses to list them, and logs any other error
            if (!(error instanceof EngineError)) {
                console.error(error);
            }
        }

        for (const { item, score } of sortMatches(scoreMatches(strings, `"${query.text}`))) {
            const { string, user, text } = item;
            const userFile = user && 'fileId' in user ? this.findEngineFile(file, user.fileId) : undefined;
            const rows = userFile ? await this.openFiles.list(userFile).then(listing => listing.rows, () => []) : [];
            const index = user && 'fileId' in user ? (findRowIndex(rows, user.key) ?? -1) : -1;
            const isOpenable = string.user === null || (index >= 0 && findDocumentRow(rows, index) !== undefined);
            const found = { file: userFile ?? file, rows, index, text, string };
            if (isOpenable && isInPlace(query, found.file.picked.path, file.siteEngine!.manifest.id, rows, index)) {
                matches.push({ item: found, score });
            }
            if (matches.length === maxResults) {
                break;
            }
        }

        return matches;
    }

    private findEngineFile(file: OpenFile, fileId: number): OpenFile | undefined {
        return this.openFiles.files.find(other => other.siteEngine === file.siteEngine && other.fileId === fileId);
    }

    private async open({ file, rows, index, string }: Candidate) {
        if (index < 0) {
            void vscode.window.showInformationMessage(`${file.picked.path} has this string, but its engine doesn't know the code that uses it.`);

            return;
        }

        const target = formatTarget({ fileId: file.fileId!, key: rows[index].key });
        const located = await locateCandidate(this.documents, file, target, string?.text);
        if (located) {
            await vscode.window.showTextDocument(located.uri, { selection: new vscode.Range(located.position, located.position) });
        }
    }
}
