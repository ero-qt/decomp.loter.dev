import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { readUntil } from './editor-testing';
import { findOpenFilesButton, readStoredUserFile, startWorkbench, testTimeoutMs } from './page-testing';

const openWorkbench = startWorkbench();

function findShortcutsEditor(page: Page) {
    return page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
}

// searches the editor's list for the command's id because the list only renders the rows in view
async function readCommandRows(page: Page, commandId: string): Promise<string[]> {
    const editor = findShortcutsEditor(page);
    await editor.getByPlaceholder('Type to search in keybindings').fill(commandId);
    const rows = editor.locator('.monaco-list-row').filter({ hasText: commandId });
    await rows.first().waitFor();

    return rows.allInnerTexts();
}

async function openShortcutsEditor(page: Page) {
    await page.keyboard.press('Control+K');
    await page.keyboard.press('Control+S');
    await findShortcutsEditor(page).waitFor();
}

// reads the keys and the source of the command's first row, like `Ctrl+Alt+J User`
async function readKeybinding(page: Page, commandId: string): Promise<string> {
    const [row] = await readCommandRows(page, commandId);
    const [, , ...cells] = row.split('\n');

    return cells.join('').replace('-', ' ');
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

test('keybinding changed in the Keyboard Shortcuts editor stays after a reload', async () => {
    const { page } = await openWorkbench();
    await openShortcutsEditor(page);
    await readCommandRows(page, 'workbench.action.quickOpen');

    await findShortcutsEditor(page).locator('.monaco-list-row').filter({ hasText: 'workbench.action.quickOpen' }).first().dblclick();
    // only presses the keys once the widget that records them has the focus because the workbench would take them
    // otherwise
    await page.waitForFunction(() => document.activeElement?.closest('.defineKeybindingWidget') !== null);
    await page.keyboard.press('Control+Alt+J');
    const recorded = page.locator('.defineKeybindingWidget .output');

    expect(await readUntil(async () => (await recorded.innerText()).replace(/\s/g, ''), 'Ctrl+Alt+J')).toBe('Ctrl+Alt+J');

    await page.keyboard.press('Enter');

    expect(await readUntil(() => readKeybinding(page, 'workbench.action.quickOpen'), 'Ctrl+Alt+J User')).toBe('Ctrl+Alt+J User');

    // only reloads after the workbench stored the file because the reload reads the change from the stored file
    const storedBinding = async () => (await readStoredUserFile(page, '/User/keybindings.json'))?.includes('"ctrl+alt+j"') ?? false;
    await readUntil(storedBinding, true);
    await page.reload();
    await findOpenFilesButton(page).waitFor();
    await openShortcutsEditor(page);

    expect(await readKeybinding(page, 'workbench.action.quickOpen')).toBe('Ctrl+Alt+J User');
}, testTimeoutMs);
