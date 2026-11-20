import { expect, test } from 'bun:test';
import { Color } from '@codingame/monaco-vscode-api/vscode/vs/base/common/color';
import type { Locator, Page } from 'playwright';
import { sampleFiles } from '../contract/fake';
import { aboutTab, closeTab, findTab, openCircle, readActiveTab, readTabs, readUntil, waitForTabs } from './editor-testing';
import { collectErrors, findOpenFilesButton, findSiteFile, runCommand, startWorkbench, testTimeoutMs } from './page-testing';
import { minimumContrast } from './themes/light';
import { drawTransferCode, transfer } from './transfer-code';

const openWorkbench = startWorkbench();
const balanceFile = { balance: '12.50', price: '9.00', asOf: '2026-11-19T08:00+00:00' };

// the note's lines without the balance status, which shows only with a `balance.json`
const noteLines = [
    'Support this project',
    'decomp.loter.dev runs on Uberspace for €9 a month. A bank transfer with the reference below pays Uberspace directly for the '
        + "server's uptime. You won't get a receipt, since it's a hosting payment and not a donation.",
    'Account holder',
    transfer.name,
    'IBAN',
    transfer.iban,
    'BIC',
    transfer.bic,
    'Reference',
    transfer.reference,
    'Support me on GitHub',
    'Source on GitHub',
];

function findNote(page: Page) {
    return page.locator('.editor-group-container .support-note');
}

async function readNoteLines(page: Page): Promise<string[]> {
    return (await findNote(page).innerText()).split('\n').filter(line => line.trim() !== '');
}

// serves the balance file's text, or a missing file for `undefined`, and starts the workbench again
async function reloadWithBalance(page: Page, text: string | undefined) {
    await page.route('**/balance.json', route => text === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ body: text }));
    await page.reload();
    await findOpenFilesButton(page).waitFor();
    await page.waitForLoadState('networkidle');
}

// reads whether the element of the note lies inside the About tab's pane from top to bottom
function readInsidePane(element: Locator) {
    return element.evaluate(element => {
        const area = element.closest('.support-note')!.parentElement!.getBoundingClientRect();
        const box = element.getBoundingClientRect();

        return box.top >= area.top && box.bottom <= area.bottom;
    });
}

// reads whether the note's last line, the source link, shows in the About tab's pane
function readLinkInsidePane(page: Page) {
    return readInsidePane(findNote(page).getByRole('link', { name: 'GitHub' }).last());
}

// turns the wheel over the pane until the source link shows and returns whether it shows
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

// reads whether the note lies inside the About tab's pane from left to right and whether the pane scrolls sideways
function readNoteWidthFit(page: Page) {
    return findNote(page).evaluate(note => {
        const pane = note.parentElement!;
        const area = pane.getBoundingClientRect();
        const box = note.getBoundingClientRect();

        return { insidePaneWidth: box.left >= area.left && box.right <= area.right, scrollsSideways: pane.scrollWidth > pane.clientWidth };
    });
}

test('workbench starts with the active About tab, which shows the support note with the bank details and a QR code', async () => {
    const { page } = await openWorkbench();
    const code = page.getByRole('img', { name: 'Bank transfer QR code' });

    await findNote(page).waitFor();

    expect(await readTabs(page)).toEqual([aboutTab]);
    expect(await readActiveTab(page)).toBe('About');
    expect(await readNoteLines(page)).toEqual(noteLines);
    expect(await page.getByRole('heading', { name: 'Support this project' }).count()).toBe(1);
    expect(await findNote(page).locator('code').textContent()).toBe('decomp.loter.dev');
    expect(await code.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await findSiteFile(new URL(await code.evaluate(image => (image as HTMLImageElement).currentSrc)).pathname).text())
        .toBe(drawTransferCode());
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
    await findNote(page).waitFor();
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
    expect(await readNoteLines(page)).toEqual(noteLines);
}, testTimeoutMs);

test('command palette lists Help: About as the only About command', async () => {
    const { page } = await openWorkbench();

    await page.keyboard.press('F1');
    await page.keyboard.insertText('About');
    await page.locator('.quick-input-list .monaco-list-row').first().waitFor();

    expect(await page.locator('.quick-input-list .monaco-list-row .label-name').allInnerTexts()).toEqual(['Help: About']);
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

    const links = findNote(page).getByRole('link');

    const linkValues = await links.evaluateAll(links =>
        links.map(link => [link.textContent, link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]),
    );

    expect(linkValues).toEqual([
        ['Uberspace', 'https://uberspace.de', '_blank', 'noopener noreferrer'],
        ['GitHub', 'https://github.com/sponsors/ero-qt', '_blank', 'noopener noreferrer'],
        ['GitHub', 'https://github.com/ero-qt/decomp.loter.dev', '_blank', 'noopener noreferrer'],
    ]);
}, testTimeoutMs);

test("note fits the About tab's width in an 800 by 600 window and scrolls down to its last line in a 300 pixel high window", async () => {
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

test('wheel scrolls down to the source link when the balance status shows after the About pane laid out the note', async () => {
    const { page } = await openWorkbench();
    const { promise: served, resolve: serve } = Promise.withResolvers<void>();
    await page.route('**/balance.json', async route => {
        await served;
        await route.fulfill({ body: JSON.stringify(balanceFile) });
    });
    await shrinkWindowTo300Pixels(page);
    await page.reload();
    await findNote(page).waitFor();

    serve();
    await findNote(page).locator('.support-status').waitFor();

    expect(await wheelToLink(page)).toBe(true);
}, testTimeoutMs);

test('End and Home scroll the focused About pane to the source link and back to the heading in a 300 pixel high window', async () => {
    const { page } = await openWorkbench();
    const heading = findNote(page).getByRole('heading', { name: 'Support this project' });
    await shrinkWindowTo300Pixels(page);

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
        await notes.waitFor();

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
