import { sampleFiles } from '#contract/fake';
import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { readBuildVersion } from './build-version';
import { aboutTab, closeTab, findTab, openCircle, readActiveTab, readTabs, readUntil, waitForTabs } from './editor-testing';
import { runCommand, startWorkbench, testTimeoutMs } from './page-testing';

const openWorkbench = startWorkbench();
// reads the version like the build does, so a tag's CI expects the tag and a build of an older commit fails
const { version, commit } = readBuildVersion(process.env, () => Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim());
const repository = 'https://github.com/ero-qt/decomp.loter.dev';

const pageLines = [
    'decomp.loter.dev',
    'Decompiler that runs entirely in your browser.',
    'How to use',
    'Drop files or folders anywhere on the page, or use Open Files and Open Folder in the Symbols view. Click a symbol to open it, '
        + 'and right-click its tab to open its other views to the side.',
    'Supported files',
    'Missing files',
    'A file can list the files it needs below its row in the Symbols view. Click one to load it. A PDB file adds names and types '
        + 'to a native program, and a referenced assembly lets Go to definition and Find references reach into it.',
    'Keyboard shortcuts',
    'Source on GitHub, third-party notices',
    `Version ${version} (${commit.slice(0, 7)})`,
];
// has a row for each engine that the site serves, in the order of the format texts, with its manifest's texts
const formatRows = [
    ['Format', 'Files', 'Views'],
    ['.NET assemblies', '.dll, .exe, .winmd', 'C#, IL'],
    ['Java classes and archives', '.class, .jar, .war', 'Java, Bytecode'],
    ['Native programs and libraries', '.exe, .dll, .sys, .efi, .so, .dylib, .elf and files without an extension', 'C, Assembly'],
];
const shortcutRows = [
    ['Go to definition', 'F12 or Ctrl+click'],
    ['Find references', 'Shift+F12'],
    ['Find symbol', 'Ctrl+P, then #'],
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

// reads whether the last shortcut's row lies inside the About tab's pane, above the pinned source line
function readLastRowShown(page: Page) {
    return findAboutPage(page).locator('td:text-is("Change shortcuts")').evaluate(cell => {
        const aboutPage = cell.closest('.about-page')!;
        const area = aboutPage.parentElement!.getBoundingClientRect();
        const footer = aboutPage.querySelector('.links')!.getBoundingClientRect();
        const box = cell.getBoundingClientRect();

        return box.top >= area.top && box.bottom <= Math.min(area.bottom, footer.top);
    });
}

// reads how many pixels the source line ends above the About pane's bottom
function readFooterRise(page: Page) {
    return findAboutPage(page).locator('.links').evaluate(footer => {
        const area = footer.closest('.about-page')!.parentElement!.getBoundingClientRect();

        return Math.round(area.bottom - footer.getBoundingClientRect().bottom);
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

test("About tab's tables list a row for each served engine with its formats text and the keyboard shortcuts", async () => {
    const { page } = await openWorkbench();

    expect(await readTableRows(page, 'Supported files')).toEqual(formatRows);
    expect(await readTableRows(page, 'Keyboard shortcuts')).toEqual(shortcutRows);
}, testTimeoutMs);

test("Supported files table shows each file's views on one line in an 800 by 600 window", async () => {
    const { page } = await openWorkbench();

    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForFunction(() => document.querySelector('.part.editor')!.getBoundingClientRect().width < 800);

    const table = findAboutPage(page).locator('h3:text-is("Supported files") + table');
    const lineCounts = await table.locator('td:last-child').evaluateAll(cells =>
        cells.map(cell => {
            const range = document.createRange();
            range.selectNodeContents(cell);

            return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
        }),
    );

    expect(lineCounts).toEqual([1, 1, 1]);
}, testTimeoutMs);

test("page fits the About tab's width in an 800 by 600 window and scrolls under the pinned source line in a 300 pixel high window", async () => {
    const { page } = await openWorkbench();

    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForFunction(() => document.querySelector('.part.editor')!.getBoundingClientRect().width < 800);

    expect(await readPageWidthFit(page)).toEqual({ insidePaneWidth: true, scrollsSideways: false });

    await page.setViewportSize({ width: 800, height: 300 });
    await page.waitForFunction(() => document.querySelector('.part.editor')!.getBoundingClientRect().height < 300);
    // points at the pane because a pointer on the page would first scroll the page's top into view
    await findAboutPage(page).locator('..').hover();

    expect(await readLinkInsidePane(page)).toBe(true);
    expect(await readLastRowShown(page)).toBe(false);

    // turns the wheel once per read because the workbench scrolls by about 50 pixels per turn, whatever the turn's size
    const scrollAndRead = async () => {
        await page.mouse.wheel(0, 100);

        return readLastRowShown(page);
    };

    expect(await readUntil(scrollAndRead, true)).toBe(true);
    expect(await readLinkInsidePane(page)).toBe(true);
    expect(await readPageWidthFit(page)).toEqual({ insidePaneWidth: true, scrollsSideways: false });
}, testTimeoutMs);

test("a swipe up on a touch screen scrolls the About tab's last row above the pinned source line in a 300 pixel high window", async () => {
    const { page } = await openWorkbench('dark', { hasTouch: true });
    await page.setViewportSize({ width: 800, height: 300 });
    await page.waitForFunction(() => document.querySelector('.part.editor')!.getBoundingClientRect().height < 300);
    const box = (await findAboutPage(page).locator('..').boundingBox())!;
    const x = box.x + box.width / 2;
    const cdp = await page.context().newCDPSession(page);

    // swipes up from the pane's bottom to its top once per read because one swipe moves the page by the pane's height
    const swipeAndRead = async () => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: box.y + box.height - 10 }] });
        for (let step = 1; step <= 5; step++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: box.y + box.height - 10 - step * 40 }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

        return readLastRowShown(page);
    };

    expect(await readLastRowShown(page)).toBe(false);
    expect(await readUntil(swipeAndRead, true)).toBe(true);
    expect(await readLinkInsidePane(page)).toBe(true);
}, testTimeoutMs);

test("source line sits at the About tab's bottom in a tall window and in a 300 pixel high window", async () => {
    const { page } = await openWorkbench();
    await findAboutPage(page).waitFor();

    expect(await readFooterRise(page)).toBe(0);

    await page.setViewportSize({ width: 800, height: 300 });
    await page.waitForFunction(() => document.querySelector('.part.editor')!.getBoundingClientRect().height < 300);

    expect(await readFooterRise(page)).toBe(0);
}, testTimeoutMs);

test("footer shows the version right of the source link, on the source link's line", async () => {
    const { page } = await openWorkbench();

    const [source, version] = await findAboutPage(page).locator('.links p').evaluateAll(lines =>
        lines.map(line => {
            const box = line.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(line);
            const content = range.getBoundingClientRect();

            return { top: Math.round(box.top), left: content.left, right: content.right, lineRight: box.right };
        }),
    );

    expect(version.top).toBe(source.top);
    expect(version.left).toBeGreaterThan(source.right);
    expect(Math.round(version.right)).toBe(Math.round(version.lineRight));
}, testTimeoutMs);

test('source, notices and version links open in a new tab without the opener and the referrer', async () => {
    const { page } = await openWorkbench();

    const linkValues = await findAboutPage(page).getByRole('link').evaluateAll(links =>
        links.map(link => [link.textContent, (link as HTMLAnchorElement).href, link.getAttribute('target'), link.getAttribute('rel')]),
    );

    expect(linkValues).toEqual([
        ['GitHub', repository, '_blank', 'noopener noreferrer'],
        ['third-party notices', new URL('/third-party-notices.txt', page.url()).href, '_blank', 'noopener noreferrer'],
        ...(version === 'dev' ? [] : [[version, `${repository}/releases/tag/${version}`, '_blank', 'noopener noreferrer']]),
        [commit.slice(0, 7), `${repository}/commit/${commit}`, '_blank', 'noopener noreferrer'],
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

test("notices link serves the repo's third-party notices", async () => {
    const { page } = await openWorkbench();
    const href = await findAboutPage(page).getByRole('link', { name: 'third-party notices' }).getAttribute('href');

    const response = await page.request.get(new URL(href!, page.url()).href);

    expect(await response.text()).toBe(await Bun.file(new URL('../third-party-notices.md', import.meta.url)).text());
}, testTimeoutMs);
