import { EditorInput, EditorInputCapabilities, EditorsOrder, type IEditorService, type IUntypedEditorInput, Verbosity } from './workbench';

/**
 * Creates the input class of a tab that shows a page of the site. Every input of the class matches the others, so a
 * group keeps 1 tab of the page.
 */
export function createPageInput(typeId: string, name: string, longTitle: string) {
    return class PageInput extends EditorInput {
        static readonly typeId = typeId;

        override get typeId(): string {
            return typeId;
        }

        override get resource(): undefined {
            return undefined;
        }

        override get capabilities(): EditorInputCapabilities {
            return EditorInputCapabilities.Readonly;
        }

        override getName(): string {
            return name;
        }

        // shows the long title in the tab's hover
        override getTitle(verbosity?: Verbosity): string {
            return verbosity === Verbosity.LONG ? longTitle : name;
        }

        override matches(other: EditorInput | IUntypedEditorInput): boolean {
            return other instanceof PageInput;
        }
    };
}

/** Opens the page's last active tab in its group, or a new tab of the page without an open tab of the page. */
export function openPage(editorService: IEditorService, PageInput: ReturnType<typeof createPageInput>) {
    const open = editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).find(({ editor }) => editor instanceof PageInput);

    return editorService.openEditor(open?.editor ?? new PageInput(), { pinned: true }, open?.groupId);
}
