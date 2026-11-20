import { getService } from '@codingame/monaco-vscode-api/services';
import { CommandsRegistry } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands';
import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors';
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform';
import { EditorPaneDescriptor, type IEditorPaneRegistry } from '@codingame/monaco-vscode-api/vscode/vs/workbench/browser/editor';
import { EditorExtensions, EditorsOrder } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor';
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service';
import { AboutInput } from './about-input';
import { AboutPane } from './about-pane';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
    EditorPaneDescriptor.create(AboutPane, AboutPane.typeId, 'About'),
    [new SyncDescriptor(AboutInput)],
);

// opens the last active About tab in its group, or a new About tab without an open About tab
function openAbout(editorService: IEditorService) {
    const open = editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).find(({ editor }) => editor instanceof AboutInput);

    return editorService.openEditor(open?.editor ?? new AboutInput(), { pinned: true }, open?.groupId);
}

/**
 * Opens the About tab and makes Help: About open it, because the workbench's About dialog shows nothing on this page.
 */
export async function startAbout() {
    // registers after the workbench's own Help: About handler because the newest handler of a command runs
    CommandsRegistry.registerCommand('workbench.action.showAboutDialog', accessor => openAbout(accessor.get(IEditorService)));
    await openAbout(await getService(IEditorService));
}
