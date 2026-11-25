import type { Locator, Page } from 'playwright';
import { testTimeoutMs } from './page-testing';
import { dropFiles, expandRows, findRow } from './tree-testing';

/** The About tab, which the workbench opens on start as a pinned tab. */
export const aboutTab = { label: 'About', isPreview: false };

/** Reads the label of each editor tab and whether the tab is a preview tab, in the tabs' order. */
export function readTabs(page: Page): Promise<{ label: string; isPreview: boolean }[]> {
    return page.locator('.tabs-container .tab').evaluateAll(tabs => tabs.map(tab => ({
        label: tab.querySelector('.label-name')?.textContent ?? '',
        isPreview: tab.querySelector('.monaco-icon-label.italic') !== null,
    })));
}

/** Finds the editor tab with the label. */
export function findTab(page: Page, label: string): Locator {
    return page.locator('.tabs-container .tab').filter({ has: page.locator('.label-name').getByText(label, { exact: true }) });
}

/** Closes the editor tab with the label through the tab's close button. */
export async function closeTab(page: Page, label: string) {
    const tab = findTab(page, label);
    await tab.hover();
    await tab.getByRole('button', { name: /^Close/ }).click();
}

/** Waits until the editor tabs have the labels, in the tabs' order. */
export async function waitForTabs(page: Page, ...labels: string[]) {
    await page.waitForFunction(labels => {
        const shown = [...document.querySelectorAll('.tabs-container .tab .label-name')].map(label => label.textContent);

        return JSON.stringify(shown) === JSON.stringify(labels);
    }, labels);
}

/**
 * Reads a value until the value is the expected value. Returns the last value when the wait takes longer than a step's
 * time.
 */
export async function readUntil<Value>(read: () => Promise<Value>, expected: Value): Promise<Value> {
    const end = Date.now() + testTimeoutMs / 3;
    let value = await read();
    while (!Bun.deepEquals(value, expected) && Date.now() < end) {
        await Bun.sleep(100);
        value = await read();
    }

    return value;
}

/** Reads the active editor's lines. */
export function readLines(page: Page): Promise<string[]> {
    return page.locator('.editor-group-container.active .monaco-editor .view-line').evaluateAll(lines => {
        // sorts the lines by their top because the editor keeps the lines in another order in the page
        const sorted = (lines as HTMLElement[]).sort((first, second) => parseInt(first.style.top) - parseInt(second.style.top));

        return sorted.map(line => line.textContent!.replaceAll(' ', ' '));
    });
}

/** Reads the cursor's line and column in the status bar, like `Ln 5, Col 19`. */
export async function readCursor(page: Page): Promise<string | undefined> {
    return (await page.locator('.statusbar-item').allTextContents()).find(item => /^Ln \d+, Col \d+$/.test(item));
}

/** Reads a word's hex color in the first line of the active editor that contains the line's text. */
export function readWordColor(page: Page, lineText: string, word: string): Promise<string | undefined> {
    return page.evaluate(({ lineText, word }) => {
        const lines = [...document.querySelectorAll('.editor-group-container.active .monaco-editor .view-line')];
        const line = lines.find(line => line.textContent?.replaceAll(' ', ' ').includes(lineText));
        const span = [...(line?.querySelectorAll('span > span') ?? [])].find(span => span.textContent?.trim() === word);
        const channels = span ? getComputedStyle(span).color.match(/\d+/g)?.slice(0, 3) : undefined;

        return channels && `#${channels.map(channel => Number(channel).toString(16).padStart(2, '0')).join('')}`;
    }, { lineText, word });
}

/**
 * Drops `drawing.fake` with the text and clicks a row below the class `Drawing.Circle`, which opens `Circle.code`
 * beside the About tab.
 */
export async function openCircle(page: Page, text: string, label: string) {
    await dropFiles(page, { 'drawing.fake': text });
    await expandRows(page, 'drawing.fake', 'Drawing', 'Circle');
    await findRow(page, label).click();
    await waitForTabs(page, 'About', 'Circle.code');
}

/** Finds a word's element in the first line of the active editor that contains the line's text. */
export function findWord(page: Page, lineText: string, word: string): Locator {
    const line = page.locator('.editor-group-container.active .monaco-editor .view-line').filter({ hasText: lineText }).first();

    return line.getByText(word, { exact: true }).first();
}

/** Moves the pointer over a word in the active editor and reads the hover's lines. */
export async function readHover(page: Page, lineText: string, word: string): Promise<string[]> {
    await findWord(page, lineText, word).hover();
    const hover = page.locator('.monaco-editor .monaco-hover-content').filter({ visible: true });
    await hover.waitFor();
    const text = await hover.innerText();
    await page.mouse.move(0, 0);
    await hover.waitFor({ state: 'detached' });

    // reads a no-break space as a space because the hover writes each space in plain text as a no-break space
    return text.replaceAll('\u00a0', ' ').split('\n').filter(line => line.trim() !== '');
}

/** Waits until the notification toasts show the warnings and reads the toasts' texts. */
export function readWarnings(page: Page, ...expected: string[]): Promise<string[]> {
    return readUntil(() => page.locator('.notification-toast .notification-list-item-message').allTextContents(), expected);
}

/** Reads the label of the active editor group's active tab. */
export function readActiveTab(page: Page): Promise<string | null> {
    return page.locator('.editor-group-container.active .tab.active .label-name').textContent();
}

/** Counts the cursors in the active editor. */
export function countCursors(page: Page): Promise<number> {
    return page.locator('.editor-group-container.active .monaco-editor .cursors-layer .cursor').count();
}

/**
 * Waits for the references peek and reads each row's text. A file's row reads as the file's label and the count of the
 * file's references.
 */
export async function readReferences(page: Page): Promise<string[]> {
    const rows = page.locator('.reference-zone-widget .ref-tree .monaco-list-row');
    await rows.first().waitFor();

    return rows.evaluateAll(rows => {
        // sorts the rows by their index because the tree keeps the rows in another order in the page
        const sorted = (rows as HTMLElement[]).sort((first, second) => Number(first.dataset.index) - Number(second.dataset.index));

        return sorted.map(row => {
            const label = row.querySelector('.reference-file .label-name')?.textContent;

            return label ? `${label} ${row.querySelector('.count')?.textContent}` : row.textContent!.replaceAll(' ', ' ').trim();
        });
    });
}

/**
 * Reads each result of the open picker as its icon, label and description, like
 * `symbol-method Area Shape • shapes.fake`.
 */
export function readResults(page: Page): Promise<string[]> {
    return page.locator('.quick-input-list .monaco-list-row').evaluateAll(rows => rows.map(row => {
        const icon = /codicon-(symbol-[\w-]+)/.exec(row.querySelector('.quick-input-list-icon')?.className ?? '')?.[1];
        const label = row.querySelector('.label-name')?.textContent;
        const description = row.querySelector('.label-description')?.textContent;

        return [icon, label, description].filter(Boolean).join(' ');
    }));
}
