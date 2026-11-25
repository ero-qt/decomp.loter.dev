import {
    addDisposableListener,
    type Dimension,
    DomScrollableElement,
    EditorPane,
    EventType,
    Gesture,
    type GestureEvent,
    type IEditorGroup,
    IStorageService,
    ITelemetryService,
    IThemeService,
    KeyCode,
    StandardKeyboardEvent,
    toDisposable,
    TouchEventType,
} from './workbench';

// scrolls by about 2 lines per arrow key like the extension details of upstream's chat customizations
const arrowScrollPixels = 40;

/**
 * Creates the pane class of a tab that shows its own copy of the page in the template, filled by `fill`. The pane shows
 * the page in the workbench's own scrollable element because the workbench cancels the browser's scrolling by the mouse
 * wheel and by touch.
 */
export function createPagePane(typeId: string, template: HTMLTemplateElement, fill: (page: HTMLElement) => void = () => {}) {
    class PagePane extends EditorPane {
        static readonly typeId = typeId;
        private readonly content = document.createElement('div');
        // leaves out the shadow at the top of a scrolled page because the page's pinned footer has none
        private readonly scrollable = this._register(new DomScrollableElement(this.content, { useShadows: false }));

        constructor(group: IEditorGroup, telemetryService: ITelemetryService, themeService: IThemeService, storageService: IStorageService) {
            super(typeId, group, telemetryService, themeService, storageService);
        }

        protected override createEditor(parent: HTMLElement) {
            const page = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
            fill(page);

            // measures the page again on each change of its size because a filled part can show after the pane measured
            // the page
            const observer = new ResizeObserver(() => this.scrollable.scanDomNode());
            observer.observe(page);
            this._register(toDisposable(() => observer.disconnect()));
            this._register(addDisposableListener(this.content, EventType.KEY_DOWN, event => this.scrollByKey(new StandardKeyboardEvent(event))));
            // scrolls by each swipe's distance like the workbench's lists because the scrollable element only takes the
            // wheel
            this._register(Gesture.addTarget(this.content));
            this._register(addDisposableListener(this.content, TouchEventType.Change, event => this.scrollBySwipe(event as GestureEvent)));

            this.content.className = 'page-pane';
            this.content.tabIndex = -1;
            this.content.append(page);
            parent.append(this.scrollable.getDomNode());
        }

        private scrollBySwipe(event: GestureEvent) {
            const { scrollTop } = this.scrollable.getScrollPosition();
            this.scrollable.setScrollPosition({ scrollTop: scrollTop - event.translationY });
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
    ITelemetryService(PagePane, undefined, 1);
    IThemeService(PagePane, undefined, 2);
    IStorageService(PagePane, undefined, 3);

    return PagePane;
}
