import { vscode } from './api';
import { symbolsViewId } from './config';
import { listExtensions, loadEngines } from './engines';
import { OpenFiles } from './files';
import { listenForDrops, type PickedFile, pickFiles } from './picking';
import { addSymbolsWelcome } from './registration';
import { SymbolsTree, type ViewRow } from './tree';

const { engines, errorTexts } = await loadEngines(document.baseURI);
const openFiles = new OpenFiles(engines);
const view = vscode.window.createTreeView(symbolsViewId, { treeDataProvider: new SymbolsTree(openFiles), showCollapseAll: true });

function open(pickedFiles: PickedFile[]) {
    return vscode.window.withProgress({ location: { viewId: symbolsViewId } }, () => openFiles.open(pickedFiles));
}

vscode.commands.registerCommand('decomp.openFiles', async () => open(await pickFiles(listExtensions(engines))));
vscode.commands.registerCommand('decomp.openFolder', async () => open(await pickFiles([], true)));
// closes the selected row when the command doesn't get a row because the Delete key runs the command without arguments
vscode.commands.registerCommand('decomp.close', (viewRow: ViewRow | undefined = view.selection[0]) => {
    return viewRow?.contextValue === 'file' && openFiles.close(viewRow.file);
});
listenForDrops(pickedFiles => void open(pickedFiles));
addSymbolsWelcome(errorTexts);
