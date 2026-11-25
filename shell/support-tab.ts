import { productConfiguration } from './config';
import { createPageInput, openPage } from './page-input';
import { createPagePane } from './page-pane';
import { fillSupportNote } from './support';
import supportCodeUrl from './support-code.svg?url';
import {
    Action2,
    Categories,
    Codicon,
    EditorExtensions,
    EditorPaneDescriptor,
    type IEditorPaneRegistry,
    IEditorService,
    MenuId,
    registerAction2,
    Registry,
    type ServicesAccessor,
    SyncDescriptor,
} from './workbench';

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
            menu: { id: MenuId.TitleBar, group: 'navigation', order: 2 },
        });
    }

    override async run(accessor: ServicesAccessor) {
        await openPage(accessor.get(IEditorService), SupportInput);
    }
});
