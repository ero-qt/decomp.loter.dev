import type { Uri } from 'vscode';
import { formatTarget } from '../contract/document';
import { vscode } from './api';
import { documentScheme, symbolsViewId } from './config';
import { parseDocumentPath } from './document-paths';
import { RowDocuments } from './documents';
import { listExtensions, loadEngines } from './engines';
import { OpenFiles } from './files';
import { findMissingFileExtensions, loadMissingFileCommand } from './missing-files';
import { formatUnopenedText, listenForDrops, type PickedFile, pickFiles } from './picking';
import { addSymbolsWelcome, registerViews } from './registration';
import { SymbolSearch } from './search';
import { SymbolFeatures } from './symbol-features';
import { tokenLegend } from './tokens';
import { SymbolsTree, ViewRow } from './tree';
import { formatShowBesideCommand } from './view-menus';

const { engines, errorTexts } = await loadEngines(document.baseURI);
const openFiles = new OpenFiles(engines);
const documents = new RowDocuments(openFiles);
const features = new SymbolFeatures(openFiles, documents);
const view = vscode.window.createTreeView(symbolsViewId, { treeDataProvider: new SymbolsTree(openFiles), showCollapseAll: true });

// reads the row target from a row, from a document's URI or from the active editor's document because the command gets
// a row from the Symbols view's menu, a URI from a tab's menus and neither from the command palette
function readTarget(engineId: string, source: ViewRow | Uri | undefined = vscode.window.activeTextEditor?.document.uri) {
    if (source instanceof ViewRow) {
        return formatTarget({ fileId: source.file!.fileId!, key: source.row!.key });
    }

    const path = source?.scheme === documentScheme ? parseDocumentPath(source.path) : undefined;

    return path?.engineId === engineId ? formatTarget(path) : undefined;
}

async function open(pickedFiles: PickedFile[]) {
    const unopened = await vscode.window.withProgress({ location: { viewId: symbolsViewId } }, () => openFiles.open(pickedFiles));
    const warning = formatUnopenedText(pickedFiles, unopened);
    if (warning) {
        void vscode.window.showWarningMessage(warning);
    }
}

vscode.commands.registerCommand('decomp.openFiles', async () => open(await pickFiles(listExtensions(engines))));
vscode.commands.registerCommand('decomp.openFolder', async () => open(await pickFiles([], 'folder')));
// takes the open file's path because a command link in a hover only takes JSON arguments
vscode.commands.registerCommand(loadMissingFileCommand, async (name: string, path: string) => {
    const [picked] = await pickFiles(findMissingFileExtensions(name), 'file');
    const file = openFiles.files.find(file => file.picked.path === path);
    if (!picked || !file) {
        return;
    }

    const isLoaded = await vscode.window.withProgress({ location: { viewId: symbolsViewId } }, () => openFiles.load(file, name, picked));
    if (!isLoaded) {
        void vscode.window.showWarningMessage(formatUnopenedText([picked], [picked])!);
    }
});
// closes the selected row when the command doesn't get a row because the Delete key runs the command without arguments
vscode.commands.registerCommand('decomp.close', (viewRow: ViewRow | undefined = view.selection[0]) => {
    return viewRow?.contextValue === 'file' && openFiles.close(viewRow.file);
});
vscode.commands.registerCommand('decomp.showRow', documents.show, documents);
for (const siteEngine of engines) {
    for (const { id } of siteEngine.manifest.views) {
        vscode.commands.registerCommand(formatShowBesideCommand(siteEngine.manifest.id, id), (source?: ViewRow | Uri) => {
            const target = readTarget(siteEngine.manifest.id, source);

            return target && documents.showBeside(siteEngine, target, id);
        });
    }
}
vscode.workspace.registerTextDocumentContentProvider(documentScheme, documents);
vscode.languages.registerDocumentSemanticTokensProvider({ scheme: documentScheme }, documents, tokenLegend);
vscode.languages.registerHoverProvider({ scheme: documentScheme }, features);
vscode.languages.registerDefinitionProvider({ scheme: documentScheme }, features);
vscode.languages.registerReferenceProvider({ scheme: documentScheme }, features);
vscode.languages.registerDocumentSymbolProvider({ scheme: documentScheme }, features);
vscode.languages.registerWorkspaceSymbolProvider(new SymbolSearch(openFiles, documents));
registerViews(engines.map(({ manifest }) => manifest));
listenForDrops(pickedFiles => void open(pickedFiles));
addSymbolsWelcome(errorTexts);
