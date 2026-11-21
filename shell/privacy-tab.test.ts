import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { aboutTab, findTab, readActiveTab, readTabs, readUntil, waitForTabs } from './editor-testing';
import { findSiteFile, runCommand, startWorkbench, testTimeoutMs } from './page-testing';

const openWorkbench = startWorkbench();
const privacyTab = { label: 'Privacy', isPreview: false };

const noticeLines = [
    'Privacy',
    "Website doesn't use any cookies.",
    'Provided files are read in the browser and never uploaded.',
    'Access and error logs are off on the host (Uberspace).',
];

function findNotice(page: Page) {
    return page.locator('.editor-group-container .privacy-page');
}

function findShield(page: Page) {
    return page.locator('.part.titlebar').getByRole('button', { name: 'Privacy', exact: true });
}

async function openPrivacy(page: Page) {
    await findShield(page).click();
    await findNotice(page).waitFor();
}

function readNoticeLines(page: Page): Promise<string[]> {
    return findNotice(page).locator('h1, p').allInnerTexts();
}

test('workbench starts without the Privacy tab', async () => {
    const { page } = await openWorkbench();

    await findShield(page).waitFor();

    expect(await readTabs(page)).toEqual([aboutTab]);
    expect(await findNotice(page).count()).toBe(0);
}, testTimeoutMs);

test("title bar's shield opens the Privacy tab, which shows the notice without a link", async () => {
    const { page } = await openWorkbench();

    await openPrivacy(page);

    expect(await readTabs(page)).toEqual([aboutTab, privacyTab]);
    expect(await readActiveTab(page)).toBe('Privacy');
    expect(await readNoticeLines(page)).toEqual(noticeLines);
    expect(await findNotice(page).getByRole('link').count()).toBe(0);
}, testTimeoutMs);

test("title bar's shield sits left of the heart", async () => {
    const { page } = await openWorkbench();

    const labels = await page.locator('.part.titlebar .action-label.codicon').evaluateAll(icons =>
        icons.map(icon => icon.getAttribute('aria-label')).filter(label => label === 'Privacy' || label === 'Support decomp.loter.dev'),
    );

    expect(labels).toEqual(['Privacy', 'Support decomp.loter.dev']);
}, testTimeoutMs);

test("title bar's shield shows the open Privacy tab again without a second Privacy tab", async () => {
    const { page } = await openWorkbench();
    await openPrivacy(page);
    await findTab(page, 'About').click();
    await readUntil(() => readActiveTab(page), 'About');

    await findShield(page).click();

    expect(await readUntil(() => readActiveTab(page), 'Privacy')).toBe('Privacy');
    expect(await readTabs(page)).toEqual([aboutTab, privacyTab]);
}, testTimeoutMs);

test("title bar's shield shows the hover Privacy", async () => {
    const { page } = await openWorkbench();

    await findShield(page).hover();

    await page.locator('.monaco-hover').filter({ hasText: 'Privacy' }).waitFor();
}, testTimeoutMs);

test('Help: Privacy opens the Privacy tab', async () => {
    const { page } = await openWorkbench();

    await runCommand(page, 'Help: Privacy');
    await waitForTabs(page, 'About', 'Privacy');

    expect(await readActiveTab(page)).toBe('Privacy');
    expect(await readNoticeLines(page)).toEqual(noticeLines);
}, testTimeoutMs);

test("built site doesn't have a privacy page of its own", async () => {
    expect(await findSiteFile('/privacy.html').exists()).toBe(false);
    expect(await findSiteFile('/sitemap.xml').text()).not.toContain('privacy');
});
