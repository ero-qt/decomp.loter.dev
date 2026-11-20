import { expect, test } from 'bun:test';
import { Color } from '@codingame/monaco-vscode-api/vscode/vs/base/common/color';
import type { Locator, Page } from 'playwright';
import { aboutTab, findTab, readActiveTab, readTabs, readUntil, waitForTabs } from './editor-testing';
import { collectErrors, findOpenFilesButton, findSiteFile, runCommand, startWorkbench, testTimeoutMs } from './page-testing';
import { minimumContrast } from './themes/light';
import { drawTransferCode, transfer } from './transfer-code';

const openWorkbench = startWorkbench();
const balanceFile = { balance: '12.50', price: '9.00', asOf: '2026-11-19T08:00+00:00' };
const supportTab = { label: 'Support', isPreview: false };

// the note's lines without the balance status, which shows only with a `balance.json`
const noteLines = [
    'Support this project',
    'decomp.loter.dev runs on Uberspace for €9 a month. Uberspace is a small, owner-managed hosting company from Germany whose '
        + "data centers run only on renewable energy. A bank transfer with the reference below pays for the server's uptime.",
    'Account holder',
    transfer.name,
    'IBAN',
    transfer.iban,
    'BIC',
    transfer.bic,
    'Reference',
    transfer.reference,
    "The money goes to Uberspace, not to me. You won't get a receipt, since it's a hosting payment and not a donation.",
    'Support me on GitHub',
];

function findNote(page: Page) {
    return page.locator('.editor-group-container .support-note');
}

function findHeart(page: Page) {
    return page.locator('.part.titlebar').getByRole('button', { name: 'Support decomp.loter.dev' });
}

async function openSupport(page: Page) {
    await findHeart(page).click();
    await findNote(page).waitFor();
}

async function readNoteLines(page: Page): Promise<string[]> {
    return (await findNote(page).innerText()).split('\n').filter(line => line.trim() !== '');
}

// serves the balance file's text, or a missing file for `undefined`, starts the workbench again and opens the Support
// tab
async function reloadWithBalance(page: Page, text: string | undefined) {
    await page.route('**/balance.json', route => text === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ body: text }));
    await page.reload();
    await findOpenFilesButton(page).waitFor();
    await openSupport(page);
    await page.waitForLoadState('networkidle');
}

// reads whether the element of the note lies inside the Support tab's pane from top to bottom
function readInsidePane(element: Locator) {
    return element.evaluate(element => {
        const area = element.closest('.support-note')!.parentElement!.getBoundingClientRect();
        const box = element.getBoundingClientRect();

        return box.top >= area.top && box.bottom <= area.bottom;
    });
}

// reads whether the note's last line, the sponsor link, shows in the Support tab's pane
function readLinkInsidePane(page: Page) {
    return readInsidePane(findNote(page).getByRole('link', { name: 'GitHub' }));
}

// turns the wheel over the pane until the sponsor link shows and returns whether it shows
async function wheelToLink(page: Page) {
    // points at the pane because a pointer on the note would first scroll the note's top into view
    await findNote(page).locator('..').hover();
    // turns the wheel once per read because the workbench scrolls by about 50 pixels per turn, whatever the turn's size
    const scrollAndRead = async () => {
        await page.mouse.wheel(0, 100);

        return readLinkInsidePane(page);
    };

    return readUntil(scrollAndRead, true);
}

async function shrinkWindowTo300Pixels(page: Page) {
    await page.setViewportSize({ width: 800, height: 300 });
    await page.waitForFunction(() => document.querySelector('.part.editor')!.getBoundingClientRect().height < 300);
}

// reads whether the note lies inside the Support tab's pane from left to right and whether the pane scrolls sideways
function readNoteWidthFit(page: Page) {
    return findNote(page).evaluate(note => {
        const pane = note.parentElement!;
        const area = pane.getBoundingClientRect();
        const box = note.getBoundingClientRect();

        return { insidePaneWidth: box.left >= area.left && box.right <= area.right, scrollsSideways: pane.scrollWidth > pane.clientWidth };
    });
}

function readColor(element: Locator) {
    return element.evaluate(element => getComputedStyle(element).color);
}

// reads the theme's red through a probe because the theme writes the red in hex and the browser computes colors in rgb
function readThemeRed(page: Page) {
    return page.locator('.monaco-workbench').evaluate(workbench => {
        const probe = document.createElement('span');
        probe.style.color = getComputedStyle(workbench).getPropertyValue('--vscode-charts-red');
        workbench.append(probe);
        const red = getComputedStyle(probe).color;
        probe.remove();

        return red;
    });
}

test('workbench starts without the Support tab', async () => {
    const { page } = await openWorkbench();

    await findHeart(page).waitFor();

    expect(await readTabs(page)).toEqual([aboutTab]);
    expect(await findNote(page).count()).toBe(0);
}, testTimeoutMs);

test("title bar's heart opens the Support tab, which shows the support note with the bank details and a QR code", async () => {
    const { page } = await openWorkbench();
    const code = page.getByRole('img', { name: 'Bank transfer QR code' });

    await openSupport(page);

    expect(await readTabs(page)).toEqual([aboutTab, supportTab]);
    expect(await readActiveTab(page)).toBe('Support');
    expect(await readNoteLines(page)).toEqual(noteLines);
    expect(await page.getByRole('heading', { name: 'Support this project' }).count()).toBe(1);
    expect(await findNote(page).locator('code').textContent()).toBe('decomp.loter.dev');
    expect(await findNote(page).locator('em').textContent()).toStartWith('The money goes to Uberspace');
    expect(await code.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await findSiteFile(new URL(await code.evaluate(image => (image as HTMLImageElement).currentSrc)).pathname).text())
        .toBe(drawTransferCode());
}, testTimeoutMs);

test("title bar's heart shows the open Support tab again without a second Support tab", async () => {
    const { page } = await openWorkbench();
    await openSupport(page);
    await findTab(page, 'About').click();
    await readUntil(() => readActiveTab(page), 'About');

    await findHeart(page).click();

    expect(await readUntil(() => readActiveTab(page), 'Support')).toBe('Support');
    expect(await readTabs(page)).toEqual([aboutTab, supportTab]);
}, testTimeoutMs);

test("title bar's heart shows the hover Support decomp.loter.dev", async () => {
    const { page } = await openWorkbench();

    await findHeart(page).hover();

    await page.locator('.monaco-hover').filter({ hasText: 'Support decomp.loter.dev' }).waitFor();
}, testTimeoutMs);

test('Help: Support decomp.loter.dev opens the Support tab', async () => {
    const { page } = await openWorkbench();

    await runCommand(page, 'Help: Support decomp.loter.dev');
    await waitForTabs(page, 'About', 'Support');

    expect(await readActiveTab(page)).toBe('Support');
    expect(await readNoteLines(page)).toEqual(noteLines);
}, testTimeoutMs);

test("Support tab's hover shows the site's name", async () => {
    const { page } = await openWorkbench();
    await openSupport(page);

    await findTab(page, 'Support').hover();

    await page.locator('.monaco-hover').filter({ hasText: 'Support decomp.loter.dev' }).waitFor();
}, testTimeoutMs);

test("title bar's heart and the sponsor link's heart have the theme's red", async () => {
    const { page } = await openWorkbench();
    await openSupport(page);
    const red = await readThemeRed(page);

    expect(await readColor(findHeart(page))).toBe(red);
    expect(await readColor(findNote(page).locator('.codicon-heart'))).toBe(red);
}, testTimeoutMs);

test('balance status shows the balance, the covered months and their bar from a served `balance.json`', async () => {
    const { page } = await openWorkbench();

    await reloadWithBalance(page, JSON.stringify(balanceFile));

    const status = findNote(page).locator('.support-status');
    const bar = status.getByRole('meter', { name: 'Months covered' });

    expect((await status.innerText()).split('\n').filter(line => line.trim() !== '')).toEqual([
        '€12.50',
        'paid until 2026-12-31',
        '1.4 of 12 months covered',
        'as of 2026-11-19',
    ]);
    expect(Number(await bar.getAttribute('aria-valuenow'))).toBeCloseTo(12.5 / 9);
    expect(await bar.getAttribute('aria-valuetext')).toBe('1.4 of 12 months covered');
    const filledShare = await bar.evaluate(bar => bar.firstElementChild!.getBoundingClientRect().width / bar.getBoundingClientRect().width);

    expect(filledShare).toBeCloseTo(12.5 / 108);
}, testTimeoutMs);

test("note's monthly price comes from `balance.json`", async () => {
    const { page } = await openWorkbench();

    await reloadWithBalance(page, JSON.stringify({ ...balanceFile, price: '10.50' }));

    expect(await findNote(page).locator('.support-price').innerText()).toBe('€10.50');
}, testTimeoutMs);

test('note leaves out the balance status without an error of its own when `balance.json` is missing or broken', async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);

    await reloadWithBalance(page, '{"balance": "12.50"');

    expect(await findNote(page).locator('.support-status').isVisible()).toBe(false);
    expect(await readNoteLines(page)).toEqual(noteLines);
    expect(errors).toEqual([]);

    await page.unrouteAll();
    await reloadWithBalance(page, undefined);

    expect(await findNote(page).locator('.support-status').isVisible()).toBe(false);
    expect(await readNoteLines(page)).toEqual(noteLines);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test('Uberspace and GitHub links open in a new tab without the opener and the referrer', async () => {
    const { page } = await openWorkbench();
    await openSupport(page);

    const links = findNote(page).getByRole('link');

    const linkValues = await links.evaluateAll(links =>
        links.map(link => [link.textContent, link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]),
    );

    expect(linkValues).toEqual([
        ['Uberspace', 'https://uberspace.de', '_blank', 'noopener noreferrer'],
        ['GitHub', 'https://github.com/sponsors/ero-qt', '_blank', 'noopener noreferrer'],
    ]);
}, testTimeoutMs);

test("note fits the Support tab's width in an 800 by 600 window and scrolls down to its last line in a 300 pixel high window", async () => {
    const { page } = await openWorkbench();
    await reloadWithBalance(page, JSON.stringify(balanceFile));

    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForFunction(() => document.querySelector('.part.editor')!.getBoundingClientRect().width < 800);

    expect(await readNoteWidthFit(page)).toEqual({ insidePaneWidth: true, scrollsSideways: false });

    await shrinkWindowTo300Pixels(page);

    expect(await readLinkInsidePane(page)).toBe(false);
    expect(await wheelToLink(page)).toBe(true);
    expect(await readNoteWidthFit(page)).toEqual({ insidePaneWidth: true, scrollsSideways: false });
}, testTimeoutMs);

test('wheel scrolls down to the sponsor link when the balance status shows after the Support pane laid out the note', async () => {
    const { page } = await openWorkbench();
    const { promise: served, resolve: serve } = Promise.withResolvers<void>();
    await page.route('**/balance.json', async route => {
        await served;
        await route.fulfill({ body: JSON.stringify(balanceFile) });
    });
    await shrinkWindowTo300Pixels(page);
    await page.reload();
    await openSupport(page);

    serve();
    await findNote(page).locator('.support-status').waitFor();

    expect(await wheelToLink(page)).toBe(true);
}, testTimeoutMs);

test('End and Home scroll the focused Support pane to the sponsor link and back to the heading in a 300 pixel high window', async () => {
    const { page } = await openWorkbench();
    const heading = findNote(page).getByRole('heading', { name: 'Support this project' });
    await shrinkWindowTo300Pixels(page);
    await openSupport(page);

    await heading.click();
    await page.keyboard.press('End');

    expect(await readUntil(() => readLinkInsidePane(page), true)).toBe(true);

    await page.keyboard.press('Home');

    expect(await readUntil(() => readInsidePane(heading), true)).toBe(true);
}, testTimeoutMs);

for (const command of ['View: Duplicate Editor Group Right', 'View: Split Editor Right']) {
    test(`${command} shows the support note in both groups`, async () => {
        const { page } = await openWorkbench();
        const notes = findNote(page);
        await openSupport(page);

        await runCommand(page, command);
        await notes.nth(1).waitFor();

        for (const note of await notes.all()) {
            expect((await note.innerText()).split('\n').filter(line => line.trim() !== '')).toEqual(noteLines);
        }
    }, testTimeoutMs);
}

for (const colorScheme of ['dark', 'light'] as const) {
    test(`note's text has a readable contrast on the editor's background in the ${colorScheme} theme`, async () => {
        const { page } = await openWorkbench(colorScheme);
        await openSupport(page);

        const [noteColor, background] = await findNote(page).evaluate(note => {
            const workbench = getComputedStyle(document.querySelector('.monaco-workbench')!);

            return [getComputedStyle(note).color, workbench.getPropertyValue('--vscode-editor-background')];
        });
        const backgroundColor = new Color(Color.Format.CSS.parse(background)!.rgba);
        // blends the note's color onto the background because the theme's description color is partly transparent
        const textColor = new Color(Color.Format.CSS.parse(noteColor)!.rgba).makeOpaque(backgroundColor);

        expect(textColor.getContrastRatio(backgroundColor)).toBeGreaterThanOrEqual(minimumContrast);
    }, testTimeoutMs);
}
