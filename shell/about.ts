import { getService } from '@codingame/monaco-vscode-api/services';
import { productConfiguration } from './config';
import { createPageInput, openPage } from './page-input';
import { createPagePane } from './page-pane';
import {
    CommandsRegistry,
    EditorExtensions,
    EditorPaneDescriptor,
    type IEditorPaneRegistry,
    IEditorService,
    Registry,
    SyncDescriptor,
} from './workbench';

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
