import { Codicon } from '@codingame/monaco-vscode-api/vscode/vs/base/common/codicons';
import { Categories } from '@codingame/monaco-vscode-api/vscode/vs/platform/action/common/actionCommonCategories';
import { Action2, MenuId, registerAction2 } from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions';
import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors';
import type { ServicesAccessor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation';
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform';
import { EditorPaneDescriptor, type IEditorPaneRegistry } from '@codingame/monaco-vscode-api/vscode/vs/workbench/browser/editor';
import { EditorExtensions } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor';
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service';
import { createPageInput, openPage } from './page-input';
import { createPagePane } from './page-pane';

const PrivacyInput = createPageInput('decomp.privacyInput', 'Privacy', 'Privacy');
const PrivacyPane = createPagePane('decomp.privacyPane', document.querySelector<HTMLTemplateElement>('#privacy-page-template')!);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
    EditorPaneDescriptor.create(PrivacyPane, PrivacyPane.typeId, 'Privacy'),
    [new SyncDescriptor(PrivacyInput)],
);

// shows as Help: Privacy in the command palette and as a shield left of the title bar's heart
registerAction2(class ShowPrivacyAction extends Action2 {
    constructor() {
        super({
            id: 'decomp.showPrivacy',
            title: { value: 'Privacy', original: 'Privacy' },
            category: Categories.Help,
            icon: Codicon.shield,
            f1: true,
            menu: { id: MenuId.TitleBar, group: 'navigation', order: 1 },
        });
    }

    override async run(accessor: ServicesAccessor) {
        await openPage(accessor.get(IEditorService), PrivacyInput);
    }
});
