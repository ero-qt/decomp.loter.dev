import { createPageInput, openPage } from './page-input';
import { createPagePane } from './page-pane';
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
