import { findDocumentRow, type Row } from '#contract/rows';
import type { TreeDataProvider } from 'vscode';
import { vscode } from './api';
import { type OpenFile, type OpenFiles, readErrorText } from './files';
import { drawIcon } from './icons';
import { loadMissingFileCommand } from './missing-files';
import { compareRows, findRowIndex, nameCollator, writeTooltip } from './rows';

/** A row of the Symbols view: a file's row, a missing file's row or a symbol's row. */
export class ViewRow extends vscode.TreeItem {
    /** The open file that the row belongs to. */
    file?: OpenFile;
    /** The symbol of a symbol's row. */
    row?: Row;
    /** The row above the row, which a file's row doesn't have. */
    above?: ViewRow;
    listBelow?: () => ViewRow[] | Promise<ViewRow[]>;

    constructor(label: string, options: Partial<ViewRow>) {
        super(label, options.listBelow ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        Object.assign(this, options);
    }
}

// parent's index or -1 for the top -> the indexes of the rows below
type RowsBelow = Map<number, number[]>;

let failedListingCount = 0;

function createViewRows(file: OpenFile, rows: Row[], rowsBelow: RowsBelow, parent: number, above: ViewRow): ViewRow[] {
    const indexes = rowsBelow.get(parent) ?? [];

    return indexes.toSorted((first, second) => compareRows(rows[first], rows[second])).map(index => {
        const row = rows[index];
        const hasDocumentRow = findDocumentRow(rows, index) !== undefined;

        const viewRow: ViewRow = new ViewRow(row.name, {
            file,
            row,
            above,
            description: row.detail,
            tooltip: writeTooltip(row),
            iconPath: drawIcon(row.kind, row.flags),
            command: hasDocumentRow ? { command: 'decomp.showRow', title: 'Show', arguments: [file, row] } : undefined,
            // gives a row with a document the context value `document <engine id>` because the row's menu shows the
            // engine's views
            contextValue: hasDocumentRow ? `document ${file.siteEngine!.manifest.id}` : undefined,
            listBelow: rowsBelow.has(index) ? () => createViewRows(file, rows, rowsBelow, index, viewRow) : undefined,
        });

        return viewRow;
    });
}

/** Lists a row in the Symbols view for each open file, with the file's missing files and symbols below the row. */
export class SymbolsTree implements TreeDataProvider<ViewRow> {
    private readonly changed = new vscode.EventEmitter<ViewRow | undefined>();
    // open file -> the file's row
    private readonly fileRows = new WeakMap<OpenFile, ViewRow>();
    // open file -> the text of the file's last listing: the listing's note or why the listing failed
    private readonly listedTexts = new WeakMap<OpenFile, string>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly openFiles: OpenFiles) {
        openFiles.onDidChange(() => this.changed.fire(undefined));
    }

    private findFileRow(file: OpenFile): ViewRow {
        let fileRow = this.fileRows.get(file);
        if (!fileRow) {
            fileRow = new ViewRow(file.picked.file.name, {
                file,
                tooltip: file.picked.path,
                contextValue: 'file',
                iconPath: new vscode.ThemeIcon('file-binary'),
                listBelow: file.fileId !== undefined ? () => this.listBelowFile(fileRow!, file) : undefined,
            });
            this.fileRows.set(file, fileRow);
        }
        // takes a failed `provide` call's text here too because the workbench only lists a collapsed file's rows once
        // the row expands
        fileRow.description = file.errorText ?? this.listedTexts.get(file);

        return fileRow;
    }

    private async listBelowFile(fileRow: ViewRow, file: OpenFile): Promise<ViewRow[]> {
        try {
            const { rows, note, missingFiles } = await this.openFiles.list(file);
            this.listedTexts.set(file, note);
            const description = file.errorText ?? note;
            if ((fileRow.description || '') !== description) {
                fileRow.description = description;
                this.changed.fire(fileRow);
            }

            // leaves out the rows that the first view hides because a click on a row opens the first view
            const shownIndexes = [...rows.keys()].filter(index => !(rows[index].hiddenViews & 1));
            const rowsBelow = Map.groupBy(shownIndexes, index => rows[index].parent);
            const missingFileRows = missingFiles.map(({ name, reason }) => {
                const command = { command: loadMissingFileCommand, title: 'Load', arguments: [name, file.picked.path] };

                return new ViewRow(name, { file, above: fileRow, description: reason, iconPath: new vscode.ThemeIcon('library'), command });
            });

            return [...missingFileRows, ...createViewRows(file, rows, rowsBelow, -1, fileRow)];
        } catch (error) {
            const errorText = readErrorText(error, 'The engine crashed while it listed the file.');
            this.listedTexts.set(file, errorText);
            fileRow.description = errorText;
            // gives the file's row a new id because the workbench only lists an expanded row again as a new, collapsed
            // row
            fileRow.id = `failed listing ${++failedListingCount}`;
            this.changed.fire(undefined);

            return [];
        }
    }

    /**
     * Finds the row of a document's document row by its key, with the rows above it, for the view's reveal, which finds
     * each of them among the listed rows by its label. Returns `undefined` for a document without a row, like the C of
     * a function that the listing leaves out, for a row that the view leaves out and while the selected row is a row of
     * the document, like the member whose click opened the document.
     */
    async findDocumentViewRow(file: OpenFile, key: number, selected?: ViewRow): Promise<ViewRow | undefined> {
        const { rows } = await this.openFiles.list(file);
        const index = findRowIndex(rows, key);
        const selectedIndex = selected?.file === file && selected.row ? findRowIndex(rows, selected.row.key) : -1;
        const isSelected = selectedIndex >= 0 && findDocumentRow(rows, selectedIndex) === index;
        if (index < 0 || (rows[index].hiddenViews & 1) !== 0 || isSelected) {
            return undefined;
        }

        const path: number[] = [];
        for (let current = index; current >= 0; current = rows[current].parent) {
            path.unshift(current);
        }

        return path.reduce((above, current) => new ViewRow(rows[current].name, { file, row: rows[current], above }), this.findFileRow(file));
    }

    getTreeItem(viewRow: ViewRow): ViewRow {
        return viewRow;
    }

    getParent(viewRow: ViewRow): ViewRow | undefined {
        return viewRow.above;
    }

    getChildren(viewRow?: ViewRow): ViewRow[] | Promise<ViewRow[]> {
        if (viewRow) {
            return viewRow.listBelow?.() ?? [];
        }

        const files = this.openFiles.files.toSorted((first, second) => {
            return nameCollator.compare(first.picked.file.name, second.picked.file.name);
        });

        return files.map(file => this.findFileRow(file));
    }
}
