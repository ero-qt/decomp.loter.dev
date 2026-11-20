import { addDisposableListener, type Dimension, EventType } from '@codingame/monaco-vscode-api/vscode/vs/base/browser/dom';
import { StandardKeyboardEvent } from '@codingame/monaco-vscode-api/vscode/vs/base/browser/keyboardEvent';
import { DomScrollableElement } from '@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/scrollbar/scrollableElement';
import { KeyCode } from '@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes';
import { toDisposable } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle';
import { IStorageService } from '@codingame/monaco-vscode-api/vscode/vs/platform/storage/common/storage.service';
import { ITelemetryService } from '@codingame/monaco-vscode-api/vscode/vs/platform/telemetry/common/telemetry.service';
import { IThemeService } from '@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/themeService.service';
import { EditorPane } from '@codingame/monaco-vscode-api/vscode/vs/workbench/browser/parts/editor/editorPane';
import type { IEditorGroup } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService';
import { fillSupportNote } from './support';
import supportCodeUrl from './support-code.svg?url';

const supportNoteTemplate = document.querySelector<HTMLTemplateElement>('#support-note-template')!;
// scrolls by about 2 lines per arrow key like the extension details of upstream's chat customizations
const arrowScrollPixels = 40;

/**
 * The About tab's pane, which shows its own copy of the support note in the workbench's own scrollable element, because
 * the workbench cancels the browser's scrolling by the mouse wheel.
 */
export class AboutPane extends EditorPane {
    static readonly typeId = 'decomp.aboutPane';
    private readonly content = document.createElement('div');
    private readonly scrollable = this._register(new DomScrollableElement(this.content, {}));

    constructor(group: IEditorGroup, telemetryService: ITelemetryService, themeService: IThemeService, storageService: IStorageService) {
        super(AboutPane.typeId, group, telemetryService, themeService, storageService);
    }

    protected override createEditor(parent: HTMLElement) {
        const note = supportNoteTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
        void fillSupportNote(note, supportCodeUrl);
        // measures the note again on each change of its size because the balance status can show after the pane
        // measured the note
        const observer = new ResizeObserver(() => this.scrollable.scanDomNode());
        observer.observe(note);
        this._register(toDisposable(() => observer.disconnect()));
        this._register(addDisposableListener(this.content, EventType.KEY_DOWN, event => this.scrollByKey(new StandardKeyboardEvent(event))));

        this.content.className = 'about-pane';
        this.content.tabIndex = -1;
        this.content.append(note);
        parent.append(this.scrollable.getDomNode());
    }

    private scrollByKey(event: StandardKeyboardEvent) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }

        const { scrollTop } = this.scrollable.getScrollPosition();
        const { height, scrollHeight } = this.scrollable.getScrollDimensions();
        const scrollTops: Partial<Record<KeyCode, number>> = {
            [KeyCode.UpArrow]: scrollTop - arrowScrollPixels,
            [KeyCode.DownArrow]: scrollTop + arrowScrollPixels,
            [KeyCode.PageUp]: scrollTop - height,
            [KeyCode.PageDown]: scrollTop + height,
            [KeyCode.Home]: 0,
            [KeyCode.End]: scrollHeight,
        };
        const nextScrollTop = scrollTops[event.keyCode];
        if (nextScrollTop !== undefined) {
            this.scrollable.setScrollPosition({ scrollTop: nextScrollTop });
            event.preventDefault();
            event.stopPropagation();
        }
    }

    override layout({ width, height }: Dimension) {
        this.content.style.width = `${width}px`;
        this.content.style.height = `${height}px`;
        this.scrollable.scanDomNode();
    }

    override focus() {
        super.focus();
        this.content.focus();
    }
}

// declares the pane's services by calling their decorators because the site's TypeScript doesn't compile parameter
// decorators
ITelemetryService(AboutPane, undefined, 1);
IThemeService(AboutPane, undefined, 2);
IStorageService(AboutPane, undefined, 3);
