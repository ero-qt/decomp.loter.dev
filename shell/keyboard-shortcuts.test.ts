import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { startWorkbench, testTimeoutMs } from './page-testing';

const openWorkbench = startWorkbench();

function findShortcutsEditor(page: Page) {
    return page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
}

// searches the editor's list for the command's id because the list renders only the rows in view
async function readCommandRows(page: Page, commandId: string): Promise<string[]> {
    const editor = findShortcutsEditor(page);
    await editor.getByPlaceholder('Type to search in keybindings').fill(commandId);
    const rows = editor.locator('.monaco-list-row').filter({ hasText: commandId });
    await rows.first().waitFor();

    return rows.allInnerTexts();
}

test('Ctrl+K Ctrl+S opens the Keyboard Shortcuts editor, which lists Go to File', async () => {
    const { page } = await openWorkbench();

    await page.keyboard.press('Control+K');
    await page.keyboard.press('Control+S');

    expect((await readCommandRows(page, 'workbench.action.quickOpen')).join('\n')).toContain('Go to File');
}, testTimeoutMs);

test('Preferences: Open Keyboard Shortcuts opens the Keyboard Shortcuts editor, which lists Go to File', async () => {
    const { page } = await openWorkbench();

    await page.keyboard.press('F1');
    await page.keyboard.insertText('Preferences: Open Keyboard Shortcuts');
    // picks the row by its aria label because the title alone matches 2 elements of the row
    await page.locator('.quick-input-list .monaco-list-row[aria-label="Preferences: Open Keyboard Shortcuts, Control+K Control+S"]').click();

    expect((await readCommandRows(page, 'workbench.action.quickOpen')).join('\n')).toContain('Go to File');
}, testTimeoutMs);
