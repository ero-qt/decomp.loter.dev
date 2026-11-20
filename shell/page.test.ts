import { brotliCompressSync, constants } from 'node:zlib';
import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { findSiteFile, startWorkbench, testTimeoutMs } from './page-testing';

const openWorkbench = startWorkbench();

async function readEditorBackground(page: Page, baseTheme: 'vs' | 'vs-dark') {
    const workbench = page.locator(`.monaco-workbench.${baseTheme}`);
    await workbench.waitFor();

    return workbench.evaluate(element => getComputedStyle(element).getPropertyValue('--vscode-editor-background'));
}

async function openThemePicker(page: Page) {
    await page.keyboard.press('F1');
    await page.keyboard.insertText('Preferences: Color Theme');
    const rows = page.locator('.quick-input-list .monaco-list-row');
    await rows.filter({ hasText: /^Preferences: Color Theme/ }).first().click();
    await rows.filter({ hasText: 'decomp.loter.dev Light' }).waitFor();

    return rows;
}

test('workbench starts with the title decomp.loter.dev without a policy violation or a request or hint to another host', async () => {
    const { page, violations, requests } = await openWorkbench();

    expect(await page.title()).toBe('decomp.loter.dev');
    expect(violations).toEqual([]);
    expect(requests.filter(url => new URL(url).host !== new URL(page.url()).host)).toEqual([]);
    expect(await page.locator('link[rel=preconnect], link[rel=dns-prefetch]').count()).toBe(0);
}, testTimeoutMs);

test("workbench doesn't show the activity bar, the layout controls and the empty editor's tips", async () => {
    const { page } = await openWorkbench();

    await page.locator('.editor-group-watermark').waitFor();

    for (const part of ['.part.activitybar', '[aria-label^="Customize Layout"]', '.editor-group-watermark .shortcuts']) {
        expect(await page.locator(part).filter({ visible: true }).count()).toBe(0);
    }
}, testTimeoutMs);

test('page stays in place when a part of the workbench reaches past the window', async () => {
    const { page } = await openWorkbench();

    const scrolled = await page.evaluate(() => {
        const marker = document.querySelector('#workbench')!.appendChild(document.createElement('div'));
        marker.style.cssText = 'position: absolute; left: 100vw; top: 100vh; width: 20px; height: 20px';
        window.scrollTo(20, 20);

        return [window.scrollX, window.scrollY];
    });

    expect(scrolled).toEqual([0, 0]);
}, testTimeoutMs);

test('workbench changes from the dark theme to the light theme with the system color scheme', async () => {
    const { page } = await openWorkbench();

    expect(await readEditorBackground(page, 'vs-dark')).toBe('#1e1e1e');

    await page.emulateMedia({ colorScheme: 'light' });

    expect(await readEditorBackground(page, 'vs')).toBe('#ffffff');
}, testTimeoutMs);

test('theme picker lists only the dark theme and the light theme', async () => {
    const { page } = await openWorkbench();

    const rows = await openThemePicker(page);

    expect(await rows.evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))).toEqual([
        'decomp.loter.dev Dark, dark themes',
        'decomp.loter.dev Light, light themes',
    ]);
}, testTimeoutMs);

test("workbench keeps only `DefaultOverridesCacheExists` in the browser after a theme pick and reloads in the system's theme", async () => {
    const { page } = await openWorkbench();
    const rows = await openThemePicker(page);
    await rows.filter({ hasText: 'decomp.loter.dev Light' }).click();
    await readEditorBackground(page, 'vs');

    await page.reload();

    expect(await readEditorBackground(page, 'vs-dark')).toBe('#1e1e1e');
    await page.waitForLoadState('networkidle');
    const kept = await page.evaluate(async () => ({
        localStorage: Object.entries(localStorage),
        sessionStorage: Object.entries(sessionStorage),
        databases: await indexedDB.databases(),
        caches: await caches.keys(),
        serviceWorkers: await navigator.serviceWorker.getRegistrations(),
    }));

    expect(kept).toEqual({
        localStorage: [['DefaultOverridesCacheExists', 'yes']],
        sessionStorage: [],
        databases: [],
        caches: [],
        serviceWorkers: [],
    });
    expect(await page.context().cookies()).toEqual([]);
}, testTimeoutMs);

test('files that the workbench loads to start are at most 2.2 MB with brotli', async () => {
    const { requests } = await openWorkbench();
    let size = 0;

    for (const url of new Set(requests)) {
        const bytes = await findSiteFile(new URL(url).pathname).bytes();
        // compresses with quality 9 because the default quality 11 takes 20 times longer for a size 10 percent smaller
        size += brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }).length;
    }

    expect(size).toBeLessThanOrEqual(2_200_000);
}, testTimeoutMs);
