import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { readUntil } from './editor-testing';
import { findOpenFilesButton, startWorkbench, testTimeoutMs } from './page-testing';

const openWorkbench = startWorkbench();

function findFontSizeSetting(page: Page) {
    return page.getByRole('dialog', { name: 'Settings' }).locator('.setting-item').filter({ hasText: 'Editor: Font Size' }).first();
}

function findFontSizeInput(page: Page) {
    return findFontSizeSetting(page).locator('input').first();
}

async function openSettings(page: Page) {
    await page.keyboard.press('Control+,');
    await findFontSizeInput(page).waitFor();
}

test('Ctrl+, opens the Settings editor, whose font size changed to 20 stays after a reload', async () => {
    const { page } = await openWorkbench();
    await openSettings(page);

    await findFontSizeInput(page).fill('20');
    await page.keyboard.press('Tab');
    // waits for the setting's modified mark because the Settings editor writes the setting after a short delay
    await readUntil(() => findFontSizeSetting(page).evaluate(setting => setting.classList.contains('is-configured')), true);
    await page.reload();
    await findOpenFilesButton(page).waitFor();
    await openSettings(page);

    expect(await findFontSizeInput(page).inputValue()).toBe('20');
}, testTimeoutMs);
