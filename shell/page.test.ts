import { brotliCompressSync, constants } from 'node:zlib';
import { expect, test } from 'bun:test';
import { Color } from '@codingame/monaco-vscode-api/vscode/vs/base/common/color';
import type { Page } from 'playwright';
import { closeTab } from './editor-testing';
import { findSiteFile, listOtherHostRequests, startWorkbench, testTimeoutMs } from './page-testing';

const openWorkbench = startWorkbench();

async function readEditorBackground(page: Page, baseTheme: 'vs' | 'vs-dark') {
    const workbench = page.locator(`.monaco-workbench.${baseTheme}`);
    await workbench.waitFor();

    return workbench.evaluate(element => getComputedStyle(element).getPropertyValue('--vscode-editor-background'));
}

// reads the keys in each store of the database that backs the user's data, like `/User/settings.json`
function readUserDataStores(page: Page): Promise<Record<string, IDBValidKey[]>> {
    return page.evaluate(async () => {
        const { promise: opened, resolve, reject } = Promise.withResolvers<IDBDatabase>();
        const request = indexedDB.open('vscode-web-db');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        const database = await opened;
        const stores: Record<string, IDBValidKey[]> = {};

        for (const name of database.objectStoreNames) {
            const keys = database.transaction(name).objectStore(name).getAllKeys();
            stores[name] = await new Promise((resolve, reject) => {
                keys.onsuccess = () => resolve(keys.result);
                keys.onerror = () => reject(keys.error);
            });
        }

        database.close();

        return stores;
    });
}

async function openThemePicker(page: Page) {
    await page.keyboard.press('F1');
    await page.keyboard.insertText('Preferences: Color Theme');
    const rows = page.locator('.quick-input-list .monaco-list-row');
    await rows.filter({ hasText: /^Preferences: Color Theme/ }).first().click();
    await rows.filter({ hasText: 'decomp.loter.dev Light' }).waitFor();

    return rows;
}

test("workbench starts with the About tab's title without a policy violation or a request or hint to another host", async () => {
    const { page, violations, requests } = await openWorkbench();

    expect(await page.title()).toBe('About - decomp.loter.dev');
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
    expect(await page.locator('link[rel=preconnect], link[rel=dns-prefetch]').count()).toBe(0);
}, testTimeoutMs);

test("workbench doesn't show the activity bar, the layout controls and the empty editor's tips", async () => {
    const { page } = await openWorkbench();

    await closeTab(page, 'About');
    await page.locator('.editor-group-watermark').waitFor();

    for (const part of ['.part.activitybar', '[aria-label^="Customize Layout"]', '.editor-group-watermark .shortcuts']) {
        expect(await page.locator(part).filter({ visible: true }).count()).toBe(0);
    }
}, testTimeoutMs);

test("empty editor area shows the workbench's letterpress after the About tab closes", async () => {
    const { page } = await openWorkbench();

    await closeTab(page, 'About');

    await page.locator('.part.editor .letterpress').filter({ visible: true }).waitFor();
}, testTimeoutMs);

test("title bar shows the site's logo as the app icon", async () => {
    const { page } = await openWorkbench();
    const appIcon = page.locator('.part.titlebar .window-appicon');

    await appIcon.waitFor();

    const { maskImage, width, height, iconColor, titleColor } = await appIcon.evaluate(icon => {
        const workbench = getComputedStyle(document.querySelector('.monaco-workbench')!);
        const { width, height } = icon.getBoundingClientRect();

        return {
            maskImage: getComputedStyle(icon).maskImage,
            width,
            height,
            iconColor: getComputedStyle(icon).backgroundColor,
            titleColor: workbench.getPropertyValue('--vscode-titleBar-activeForeground'),
        };
    });
    const [, url] = /^url\("(.+)"\)$/.exec(maskImage) ?? [];

    expect(await findSiteFile(new URL(url).pathname).text()).toBe(await Bun.file(new URL('logo.svg', import.meta.url)).text());
    expect(width * height).toBeGreaterThan(0);
    expect(Color.Format.CSS.parse(iconColor)!.equals(Color.Format.CSS.parse(titleColor))).toBe(true);
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

test("workbench keeps a theme pick after a reload, in the user's settings in IndexedDB and nothing else in the browser", async () => {
    const { page } = await openWorkbench();
    const rows = await openThemePicker(page);
    await rows.filter({ hasText: 'decomp.loter.dev Light' }).click();
    await readEditorBackground(page, 'vs');

    await page.reload();

    expect(await readEditorBackground(page, 'vs')).toBe('#ffffff');
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
        databases: [{ name: 'vscode-web-db', version: 3 }],
        caches: [],
        serviceWorkers: [],
    });
    const { 'vscode-userdata-store': userFiles, ...otherStores } = await readUserDataStores(page);

    expect(otherStores).toEqual({ 'vscode-filehandles-store': [], 'vscode-logs-store': [] });
    expect(userFiles).toContain('/User/settings.json');
    expect(userFiles.filter(file => !String(file).startsWith('/User/'))).toEqual([]);
    expect(await page.context().cookies()).toEqual([]);
}, testTimeoutMs);

test('files that the workbench loads to start are at most 2.5 MB with brotli', async () => {
    const { requests } = await openWorkbench();
    let size = 0;

    // leaves out `balance.json` because only the host writes the file into the site, and the fake engine's files
    // because only the tests serve them
    const siteRequests = requests.filter(url => !url.endsWith('/balance.json') && !new URL(url).pathname.startsWith('/engines/fake/'));
    for (const url of new Set(siteRequests)) {
        const bytes = await findSiteFile(new URL(url).pathname).bytes();
        // compresses with quality 9 because the default quality 11 takes 20 times longer for a size 10 percent smaller
        size += brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }).length;
    }

    // catches an engine or a big library that an import pulls into the start by mistake
    expect(size).toBeLessThanOrEqual(2_500_000);
}, testTimeoutMs);

test("page has a description, the canonical link and Open Graph tags with the site's URL for search engines", async () => {
    const { page } = await openWorkbench();
    const readContent = (selector: string) => page.locator(selector).getAttribute('content');
    const description = 'decomp.loter.dev is a decompiler by loter that runs entirely in your browser.';

    expect(await readContent('meta[name=description]')).toBe(description);
    expect(await page.locator('link[rel=canonical]').getAttribute('href')).toBe('https://decomp.loter.dev/');
    expect(await readContent('meta[property="og:title"]')).toBe('decomp.loter.dev');
    expect(await readContent('meta[property="og:description"]')).toBe(description);
    expect(await readContent('meta[property="og:url"]')).toBe('https://decomp.loter.dev/');
    expect(await readContent('meta[property="og:type"]')).toBe('website');
}, testTimeoutMs);

test('robots.txt keeps crawlers out of the files besides the page and points to the sitemap, which lists the page', async () => {
    expect((await findSiteFile('/robots.txt').text()).split('\n')).toEqual([
        'User-agent: *',
        'Allow: /',
        'Disallow: /assets/',
        'Disallow: /engines/',
        'Disallow: /balance.json',
        '',
        'Sitemap: https://decomp.loter.dev/sitemap.xml',
        '',
    ]);
    expect(await findSiteFile('/sitemap.xml').text()).toContain('<url><loc>https://decomp.loter.dev/</loc></url>');
});
