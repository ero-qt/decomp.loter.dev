import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { sampleFiles } from '../contract/fake';
import { aboutTab, closeTab, findTab, openCircle, readActiveTab, readTabs, readUntil, waitForTabs } from './editor-testing';
import { runCommand, startWorkbench, testTimeoutMs } from './page-testing';

const openWorkbench = startWorkbench();

const pageLines = [
    'decomp.loter.dev',
    'Decompiler that runs entirely in your browser.',
    'How to use',
    'Drop files or folders anywhere on the page, or use Open Files and Open Folder in the Symbols view. Click a symbol to open it, '
        + 'and right-click its tab to open its other views to the side.',
    'Supported files',
    'Keyboard shortcuts',
    'Source on GitHub',
];
const formatRows = [
    ['Format', 'Files', 'Views'],
    ['.NET assemblies', '.dll, .exe', 'C#, IL'],
    ['Java classes and archives', '.class, .jar, .war', 'Java'],
    ['Native programs and libraries', '.exe, .dll, .sys, .efi, .so, .dylib, .elf and files without an extension', 'C'],
];
const shortcutRows = [
    ['Go to definition', 'F12 or Ctrl+click'],
    ['Find references', 'Shift+F12'],
    ['Find symbol', 'Ctrl+T'],
    ['Find string', 'Ctrl+Shift+F'],
    ['Command palette', 'F1'],
    ['Change shortcuts', 'Ctrl+K Ctrl+S'],
];

function findAboutPage(page: Page) {
    return page.locator('.editor-group-container .about-page');
}

// reads the headings and paragraphs, which leave out the tables' rows
function readPageLines(page: Page): Promise<string[]> {
    return findAboutPage(page).locator('h1, h2, h3, p').allInnerTexts();
}

function readTableRows(page: Page, heading: string): Promise<string[][]> {
    const table = findAboutPage(page).locator(`h3:text-is("${heading}") + table`);

    // joins a cell's lines like the browser shows them, because a long cell wraps its text in the page's source
    return table.locator('tr').evaluateAll(rows => rows.map(row => [...row.children].map(cell => cell.textContent!.replace(/\s+/g, ' ').trim())));
}

// reads whether the source link lies inside the About tab's pane from top to bottom
function readLinkInsidePane(page: Page) {
    return findAboutPage(page).getByRole('link', { name: 'GitHub' }).evaluate(link => {
        const area = link.closest('.about-page')!.parentElement!.getBoundingClientRect();
        const box = link.getBoundingClientRect();

        return box.top >= area.top && box.bottom <= area.bottom;
    });
}

// reads whether the page lies inside the About tab's pane from left to right and whether the pane scrolls sideways
function readPageWidthFit(page: Page) {
    return findAboutPage(page).evaluate(aboutPage => {
        const pane = aboutPage.parentElement!;
        const area = pane.getBoundingClientRect();
        const box = aboutPage.getBoundingClientRect();

        return { insidePaneWidth: box.left >= area.left && box.right <= area.right, scrollsSideways: pane.scrollWidth > pane.clientWidth };
    });
}

test("workbench starts with the active About tab, which shows the site's name, how to use the site and the source link", async () => {
    const { page } = await openWorkbench();

    await findAboutPage(page).waitFor();

    expect(await readTabs(page)).toEqual([aboutTab]);
    expect(await readActiveTab(page)).toBe('About');
    expect(await readPageLines(page)).toEqual(pageLines);
    expect(await page.getByRole('heading', { name: 'decomp.loter.dev', level: 1 }).count()).toBe(1);
}, testTimeoutMs);

test("About tab's tables list the supported files with their views and the keyboard shortcuts", async () => {
    const { page } = await openWorkbench();

    expect(await readTableRows(page, 'Supported files')).toEqual(formatRows);
    expect(await readTableRows(page, 'Keyboard shortcuts')).toEqual(shortcutRows);
}, testTimeoutMs);

test("page fits the About tab's width in an 800 by 600 window and scrolls down to the source link in a 300 pixel high window", async () => {
    const { page } = await openWorkbench();

    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForFunction(() => document.querySelector('.part.editor')!.getBoundingClientRect().width < 800);

    expect(await readPageWidthFit(page)).toEqual({ insidePaneWidth: true, scrollsSideways: false });

    await page.setViewportSize({ width: 800, height: 300 });
    await page.waitForFunction(() => document.querySelector('.part.editor')!.getBoundingClientRect().height < 300);
    // points at the pane because a pointer on the page would first scroll the page's top into view
    await findAboutPage(page).locator('..').hover();

    expect(await readLinkInsidePane(page)).toBe(false);

    // turns the wheel once per read because the workbench scrolls by about 50 pixels per turn, whatever the turn's size
    const scrollAndRead = async () => {
        await page.mouse.wheel(0, 100);

        return readLinkInsidePane(page);
    };

    expect(await readUntil(scrollAndRead, true)).toBe(true);
    expect(await readPageWidthFit(page)).toEqual({ insidePaneWidth: true, scrollsSideways: false });
}, testTimeoutMs);

test('source link opens in a new tab without the opener and the referrer', async () => {
    const { page } = await openWorkbench();

    const linkValues = await findAboutPage(page).getByRole('link').evaluateAll(links =>
        links.map(link => [link.textContent, (link as HTMLAnchorElement).href, link.getAttribute('target'), link.getAttribute('rel')]),
    );

    expect(linkValues).toEqual([
        ['GitHub', 'https://github.com/ero-qt/decomp.loter.dev', '_blank', 'noopener noreferrer'],
    ]);
}, testTimeoutMs);

test("About tab's hover shows the site's name", async () => {
    const { page } = await openWorkbench();

    await findTab(page, 'About').hover();

    await page.locator('.monaco-hover').filter({ hasText: 'About decomp.loter.dev' }).waitFor();
}, testTimeoutMs);

test('About tab stays open beside an opened document', async () => {
    const { page } = await openWorkbench();

    await openCircle(page, await sampleFiles.drawing.text(), 'Draw');

    expect(await readTabs(page)).toEqual([aboutTab, { label: 'Circle.code', isPreview: true }]);
    expect(await readActiveTab(page)).toBe('Circle.code');
}, testTimeoutMs);

test('Help: About shows the open About tab again without a second About tab', async () => {
    const { page } = await openWorkbench();
    await openCircle(page, await sampleFiles.drawing.text(), 'Draw');

    await runCommand(page, 'Help: About');

    expect(await readUntil(() => readActiveTab(page), 'About')).toBe('About');
    expect(await readTabs(page)).toEqual([aboutTab, { label: 'Circle.code', isPreview: true }]);
}, testTimeoutMs);

test('Help: About shows the About tab of another group without an About tab in the active group', async () => {
    const { page } = await openWorkbench();
    await findAboutPage(page).waitFor();
    await runCommand(page, 'View: New Editor Group to the Right');
    await page.locator('.editor-group-container').nth(1).waitFor();

    await runCommand(page, 'Help: About');

    expect(await readUntil(() => readActiveTab(page), 'About')).toBe('About');
    expect(await readTabs(page)).toEqual([aboutTab]);
}, testTimeoutMs);

test('Help: About opens 1 About tab again after the About tab closes', async () => {
    const { page } = await openWorkbench();

    await closeTab(page, 'About');
    await waitForTabs(page);
    await runCommand(page, 'Help: About');
    await waitForTabs(page, 'About');

    expect(await readTabs(page)).toEqual([aboutTab]);
    expect(await readPageLines(page)).toEqual(pageLines);
}, testTimeoutMs);

test('command palette lists Help: About as the only About command', async () => {
    const { page } = await openWorkbench();

    await page.keyboard.press('F1');
    await page.keyboard.insertText('About');
    await page.locator('.quick-input-list .monaco-list-row').first().waitFor();

    expect(await page.locator('.quick-input-list .monaco-list-row .label-name').allInnerTexts()).toEqual(['Help: About']);
}, testTimeoutMs);
