import { getService } from '@codingame/monaco-vscode-api/services';
import { CommandsRegistry } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands';
import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors';
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform';
import { EditorPaneDescriptor, type IEditorPaneRegistry } from '@codingame/monaco-vscode-api/vscode/vs/workbench/browser/editor';
import { EditorExtensions } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor';
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service';
import { productConfiguration } from './config';
import { createPageInput, openPage } from './page-input';
import { createPagePane } from './page-pane';

const AboutInput = createPageInput('decomp.aboutInput', 'About', `About ${productConfiguration!.nameLong}`);
const AboutPane = createPagePane('decomp.aboutPane', document.querySelector<HTMLTemplateElement>('#about-page-template')!);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
    EditorPaneDescriptor.create(AboutPane, AboutPane.typeId, 'About'),
    [new SyncDescriptor(AboutInput)],
);

/**
 * Opens the About tab and makes Help: About open it, because the workbench's About dialog shows nothing on this page.
 */
export async function startAbout() {
    // registers after the workbench's own Help: About handler because the newest handler of a command runs
    CommandsRegistry.registerCommand('workbench.action.showAboutDialog', accessor => openPage(accessor.get(IEditorService), AboutInput));
    await openPage(await getService(IEditorService), AboutInput);
}
