import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { sampleFiles } from '../contract/fake';
import { aboutTab, closeTab, findTab, openCircle, readActiveTab, readTabs, readUntil, waitForTabs } from './editor-testing';
import { runCommand, startWorkbench, testTimeoutMs } from './page-testing';

const openWorkbench = startWorkbench();

const pageLines = [
    'decomp.loter.dev',
    'Decompiler that runs entirely in your browser.',
    'Source on GitHub',
];

function findAboutPage(page: Page) {
    return page.locator('.editor-group-container .about-page');
}

async function readPageLines(page: Page): Promise<string[]> {
    return (await findAboutPage(page).innerText()).split('\n').filter(line => line.trim() !== '');
}

test("workbench starts with the active About tab, which shows the site's name, its tagline and the source link", async () => {
    const { page } = await openWorkbench();

    await findAboutPage(page).waitFor();

    expect(await readTabs(page)).toEqual([aboutTab]);
    expect(await readActiveTab(page)).toBe('About');
    expect(await readPageLines(page)).toEqual(pageLines);
    expect(await page.getByRole('heading', { name: 'decomp.loter.dev', level: 1 }).count()).toBe(1);
}, testTimeoutMs);

test('source link opens in a new tab without the opener and the referrer', async () => {
    const { page } = await openWorkbench();

    const linkValues = await findAboutPage(page).getByRole('link').evaluateAll(links =>
        links.map(link => [link.textContent, link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]),
    );

    expect(linkValues).toEqual([['GitHub', 'https://github.com/ero-qt/decomp.loter.dev', '_blank', 'noopener noreferrer']]);
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
