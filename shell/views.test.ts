import { expect, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { fakeManifest, sampleFiles } from '../contract/fake';
import { aboutTab, closeTab, openCircle, readActiveTab, readCursor, readHover, readTabs, readUntil, waitForTabs } from './editor-testing';
import { startWorkbench, testTimeoutMs, waitForEngineReplies } from './page-testing';
import { dropAndWait, dropFiles, expandRows, findRow, startWithEngines, testEngine } from './tree-testing';

const openWorkbench = startWorkbench();
const drawing = await sampleFiles.drawing.text();
const shapes = await sampleFiles.shapes.text();

/** Finds the editor group whose active tab has the label. */
function findGroup(page: Page, label: string): Locator {
    const activeTab = page.locator('.tab.active .label-name').getByText(label, { exact: true });

    return page.locator('.editor-group-container').filter({ has: activeTab });
}

function findViewButton(page: Page, label: string, title: string): Locator {
    return findGroup(page, label).locator('.editor-actions .action-label').getByText(title, { exact: true });
}

// only reads the buttons with a text because the editor's other buttons show an icon
async function readViewButtons(page: Page, label: string): Promise<string[]> {
    const texts = await findGroup(page, label).locator('.editor-actions .action-label').allTextContents();

    return texts.filter(text => text !== '');
}

/** Reads each editor group's tab labels, in the groups' order from left to right. */
function readGroups(page: Page): Promise<string[][]> {
    return page.locator('.editor-group-container').evaluateAll(groups => {
        // sorts the groups by their left edge because the page keeps the groups in the order of their creation
        const sorted = groups.sort((first, second) => first.getBoundingClientRect().left - second.getBoundingClientRect().left);

        return sorted.map(group => [...group.querySelectorAll('.tab .label-name')].map(label => label.textContent ?? ''));
    });
}

/**
 * Reads the line at the cursor in the editor group whose active tab has the label, also in a group without the focus.
 */
function readCursorLine(page: Page, label: string): Promise<string | undefined> {
    return findGroup(page, label).evaluate(group => {
        const { top } = group.querySelector<HTMLElement>('.cursors-layer .cursor')!.style;
        const line = [...group.querySelectorAll<HTMLElement>('.view-line')].find(line => line.style.top === top);

        return line?.textContent?.replaceAll('\u00a0', ' ');
    });
}

// picks the item with the keyboard once the menu shows the item as focused because the menu can miss an early click
async function pickMenuItem(page: Page, label: string) {
    await page.getByRole('menuitem', { name: label }).hover();
    await page.locator('.context-view .action-item.focused').filter({ hasText: label }).waitFor();
    await page.keyboard.press('Enter');
}

/** Opens `Circle.code`, opens `Circle.ops` beside it with the `Ops` button and moves the focus into `Circle.ops`. */
async function focusCircleOps(page: Page) {
    await openCircle(page, drawing, 'Draw');
    await findViewButton(page, 'Circle.code', 'Ops').click();
    await findGroup(page, 'Circle.ops').locator('.view-line').first().click();
    await page.locator('.editor-group-container.active .tab.active').getByText('Circle.ops', { exact: true }).waitFor();
}

test('Ops button of `Circle.code` opens `Circle.ops` in a second editor group', async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await findViewButton(page, 'Circle.code', 'Ops').click();

    expect(await readUntil(() => readGroups(page), [['About', 'Circle.code'], ['Circle.ops']])).toEqual([['About', 'Circle.code'], ['Circle.ops']]);
    await findGroup(page, 'Circle.ops').locator('.view-line').filter({ hasText: '.public method Draw' }).waitFor();
}, testTimeoutMs);

test("Ops button of `Circle.code` keeps the focus in `Circle.code`'s editor group", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await findViewButton(page, 'Circle.code', 'Ops').click();
    await readUntil(() => readGroups(page), [['About', 'Circle.code'], ['Circle.ops']]);

    expect(await readActiveTab(page)).toBe('Circle.code');
}, testTimeoutMs);

test('Ops button of `Circle.code` opens `Circle.ops` in a preview tab', async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await findViewButton(page, 'Circle.code', 'Ops').click();
    await waitForTabs(page, 'About', 'Circle.code', 'Circle.ops');

    expect(await readTabs(page)).toEqual([aboutTab, { label: 'Circle.code', isPreview: true }, { label: 'Circle.ops', isPreview: true }]);
}, testTimeoutMs);

test('command palette in `Circle.code` lists Show Ops to the Side, which opens `Circle.ops` in a second editor group', async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await page.keyboard.press('F1');
    await page.keyboard.insertText('to the Side');
    const rows = page.locator('.quick-input-list .monaco-list-row');
    await rows.filter({ hasText: /^Show Ops to the Side/ }).waitFor();
    const labels = await rows.locator('.label-name').allTextContents();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText('>Show Ops to the Side');
    await rows.first().filter({ hasText: /^Show Ops to the Side/ }).waitFor();
    await page.keyboard.press('Enter');

    expect(labels.filter(label => label.startsWith('Show '))).toEqual(['Show Ops to the Side']);
    expect(await readUntil(() => readGroups(page), [['About', 'Circle.code'], ['Circle.ops']])).toEqual([['About', 'Circle.code'], ['Circle.ops']]);
}, testTimeoutMs);

test("Show Ops to the Side in a tab's menu opens `Circle.ops` in a second editor group", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await page.getByRole('tab', { name: 'Circle.code' }).click({ button: 'right' });
    await pickMenuItem(page, 'Show Ops to the Side');

    expect(await readUntil(() => readGroups(page), [['About', 'Circle.code'], ['Circle.ops']])).toEqual([['About', 'Circle.code'], ['Circle.ops']]);
}, testTimeoutMs);

test("Show Ops to the Side in `Draw`'s menu in the Symbols view opens the document row's `Circle.ops` beside", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await findRow(page, 'Draw').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show Ops to the Side' }).waitFor();
    const items = await page.getByRole('menuitem').allTextContents();
    await pickMenuItem(page, 'Show Ops to the Side');

    expect(items).not.toContain('Show Code to the Side');
    expect(await readUntil(() => readGroups(page), [['About', 'Circle.code'], ['Circle.ops']])).toEqual([['About', 'Circle.code'], ['Circle.ops']]);
}, testTimeoutMs);

test("Show Ops to the Side in `Draw`'s menu puts the cursor of `Circle.ops` at `Draw`", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await findRow(page, 'Draw').click({ button: 'right' });
    await pickMenuItem(page, 'Show Ops to the Side');
    await readUntil(() => readGroups(page), [['About', 'Circle.code'], ['Circle.ops']]);
    await findGroup(page, 'Circle.ops').locator('.tab.active').click();

    expect(await readUntil(() => readCursor(page), 'Ln 5, Col 20')).toBe('Ln 5, Col 20');
}, testTimeoutMs);

test("file that closes during the read of a document beside doesn't get a tab", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { test: testEngine });
    await dropFiles(page, { 'late.test': '' });
    await expandRows(page, 'late.test');

    await findRow(page, 'Listed').click({ button: 'right' });
    await pickMenuItem(page, 'Show Ops to the Side');
    await findRow(page, 'late.test').click();
    await page.keyboard.press('Delete');
    // waits for the document's read because the document's tab would open then
    await waitForEngineReplies(page, 'read');

    expect(await readTabs(page)).toEqual([aboutTab]);
}, testTimeoutMs);

test('Code button of `Circle.ops` opens `Circle.code` in a second editor group', async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');
    await findViewButton(page, 'Circle.code', 'Ops').click();
    // closes the About tab too because the first editor group then closes and leaves `Circle.ops` as the only group
    await closeTab(page, 'About');
    await closeTab(page, 'Circle.code');
    await readUntil(() => readGroups(page), [['Circle.ops']]);

    expect(await readViewButtons(page, 'Circle.ops')).toEqual(['Code']);

    await findViewButton(page, 'Circle.ops', 'Code').click();

    expect(await readUntil(() => readGroups(page), [['Circle.ops'], ['Circle.code']])).toEqual([['Circle.ops'], ['Circle.code']]);
}, testTimeoutMs);

test('Code button of `Circle.ops` shows `Circle.code` in the editor group that has `Circle.code`', async () => {
    const { page } = await openWorkbench();
    await focusCircleOps(page);

    await findViewButton(page, 'Circle.ops', 'Code').click();
    // waits for the cursor of `Circle.code` at the class because a third editor group would open by then
    expect(await readUntil(() => readCursorLine(page, 'Circle.code'), 'public sealed class Circle')).toBe('public sealed class Circle');
    expect(await readGroups(page)).toEqual([['About', 'Circle.code'], ['Circle.ops']]);
    expect(await readActiveTab(page)).toBe('Circle.ops');
}, testTimeoutMs);

test('F12 in `Circle.ops` opens the declaration in the ops view', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'shapes.fake': shapes });
    await focusCircleOps(page);

    await findGroup(page, 'Circle.ops').locator('.view-line').getByText('Shapes.Shape.Area', { exact: true }).click();
    await page.keyboard.press('F12');

    expect(await readUntil(() => readActiveTab(page), 'Shape.ops')).toBe('Shape.ops');
    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 29')).toBe('Ln 2, Col 29');
}, testTimeoutMs);

test("hover in `Circle.ops` shows the symbol's declaration in the ops view", async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'shapes.fake': shapes });
    await focusCircleOps(page);

    expect(await readHover(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area')).toEqual([
        '.public abstract method Area',
        'in Shapes.Shape',
        'file shapes.fake',
        'key 3',
    ]);
}, testTimeoutMs);

test("document of an engine with 1 view doesn't show a view button", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { test: { ...testEngine, views: [fakeManifest.views[0]] } });
    await dropFiles(page, { 'listed.test': '' });
    await expandRows(page, 'listed.test');

    await findRow(page, 'Listed').click();
    await waitForTabs(page, 'About', 'Listed.code');
    // waits for the editor's buttons because the title draws them after the tab
    await findGroup(page, 'Listed.code').locator('.editor-actions .action-label').first().waitFor();

    expect(await readViewButtons(page, 'Listed.code')).toEqual([]);
}, testTimeoutMs);

test("documents of 2 engines show only the buttons of their own engine's views", async () => {
    const { page } = await openWorkbench();
    const tree = { id: 'tree', title: 'Tree', extension: '.tree', language: 'plaintext' };
    await startWithEngines(page, { fake: null, test: { ...testEngine, views: [fakeManifest.views[0], tree] } });
    await openCircle(page, drawing, 'Draw');
    await findViewButton(page, 'Circle.code', 'Ops').waitFor();

    expect(await readViewButtons(page, 'Circle.code')).toEqual(['Ops']);

    await dropFiles(page, { 'listed.test': '' });
    await expandRows(page, 'listed.test');
    await findRow(page, 'Listed').click();
    await waitForTabs(page, 'About', 'Listed.code');
    await findViewButton(page, 'Listed.code', 'Tree').waitFor();

    expect(await readViewButtons(page, 'Listed.code')).toEqual(['Tree']);
}, testTimeoutMs);
