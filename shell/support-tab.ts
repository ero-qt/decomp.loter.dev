import { Codicon } from '@codingame/monaco-vscode-api/vscode/vs/base/common/codicons';
import { Categories } from '@codingame/monaco-vscode-api/vscode/vs/platform/action/common/actionCommonCategories';
import { Action2, MenuId, registerAction2 } from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions';
import { SyncDescriptor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors';
import type { ServicesAccessor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation';
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform';
import { EditorPaneDescriptor, type IEditorPaneRegistry } from '@codingame/monaco-vscode-api/vscode/vs/workbench/browser/editor';
import { EditorExtensions } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor';
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service';
import { productConfiguration } from './config';
import { createPageInput, openPage } from './page-input';
import { createPagePane } from './page-pane';
import { fillSupportNote } from './support';
import supportCodeUrl from './support-code.svg?url';

const supportTitle = `Support ${productConfiguration!.nameLong}`;
const SupportInput = createPageInput('decomp.supportInput', 'Support', supportTitle);
const SupportPane = createPagePane(
    'decomp.supportPane',
    document.querySelector<HTMLTemplateElement>('#support-page-template')!,
    note => void fillSupportNote(note, supportCodeUrl),
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
    EditorPaneDescriptor.create(SupportPane, SupportPane.typeId, 'Support'),
    [new SyncDescriptor(SupportInput)],
);

// shows as Help: Support decomp.loter.dev in the command palette and as a heart at the title bar's right end
registerAction2(class ShowSupportAction extends Action2 {
    constructor() {
        super({
            id: 'decomp.showSupport',
            title: { value: supportTitle, original: supportTitle },
            category: Categories.Help,
            icon: Codicon.heart,
            f1: true,
            menu: { id: MenuId.TitleBar, group: 'navigation' },
        });
    }

    override async run(accessor: ServicesAccessor) {
        await openPage(accessor.get(IEditorService), SupportInput);
    }
});
