import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { readLines, readUntil, readWordColor, waitForTabs } from '../../shell/editor-testing';
import { listOtherHostRequests, startWorkbench, testTimeoutMs } from '../../shell/page-testing';
import { dropFiles, expandRows, findRow, readRowIcon, readRowTexts } from '../../shell/tree-testing';
import { readFixture } from './testing';

const openWorkbench = startWorkbench();
const drawing = await (await readFixture('Drawing.dll')).bytes();
// the start of the class codicon's path, which the icon of a class's row draws
const classIconPath = 'M13.2069 10.4999';
const painterLine = 'public class Painter';
// the fixture's string as the editor writes it, with a no-break space
const fixtureString = '"héllo\u00a0✓"';
const dotnetFiles = /\/engines\/dotnet\/(?!manifest\.json)/;

// picks the item with the keyboard once the menu shows the item as focused because the menu can miss an early click
async function pickMenuItem(page: Page, label: string) {
    await page.getByRole('menuitem', { name: label }).hover();
    await page.locator('.context-view .action-item.focused').filter({ hasText: label }).waitFor();
    await page.keyboard.press('Enter');
}

// drops `Drawing.dll` and opens `Painter.cs` from the class's row
async function openPainter(page: Page) {
    await dropFiles(page, { 'Drawing.dll': drawing });
    await expandRows(page, 'Drawing.dll', 'Drawing');
    await findRow(page, 'Painter').click();
    await waitForTabs(page, 'About', 'Painter.cs');
}

test("dropped assembly lists its namespace and types, and a click on a type opens its C# with the theme's colors", async () => {
    const { page, violations, requests } = await openWorkbench();

    await openPainter(page);

    expect(await readRowIcon(page, 'Painter')).toContain(classIconPath);
    expect(await readUntil(async () => (await readLines(page)).includes(painterLine), true)).toBe(true);
    expect(await readUntil(() => readWordColor(page, painterLine, 'Painter'), '#56c9a2')).toBe('#56c9a2');
    expect(await readUntil(() => readWordColor(page, painterLine, 'public'), '#609fd2')).toBe('#609fd2');

    // reveals `Paint`, whose string and the number of the method below it are further down than the editor shows
    await expandRows(page, 'Painter');
    await findRow(page, 'Paint(Shape)').click();
    expect(await readUntil(() => readWordColor(page, 'héllo', fixtureString), '#c7988b')).toBe('#c7988b');
    expect(await readUntil(() => readWordColor(page, '% 2 !=', '2'), '#deb684')).toBe('#deb684');
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, testTimeoutMs * 2);

test("workbench loads the .NET worker and runtime only after a drop, and the C# grammar only for a C# document", async () => {
    const { page, requests } = await openWorkbench();
    const startRequests = [...requests];

    await dropFiles(page, { 'Drawing.dll': drawing });
    await expandRows(page, 'Drawing.dll', 'Drawing');
    const listedRequests = [...requests];

    await findRow(page, 'Painter').click();
    await waitForTabs(page, 'About', 'Painter.cs');
    await readUntil(() => readWordColor(page, painterLine, 'public'), '#609fd2');
    const grammar = requests.filter(url => /csharp\.tmLanguage/.test(url));

    expect(startRequests.filter(url => dotnetFiles.test(url))).toEqual([]);
    expect(listedRequests.some(url => url.endsWith('/engines/dotnet/worker.js'))).toBe(true);
    expect(listedRequests.some(url => url.endsWith('/engines/dotnet/_framework/dotnet.js'))).toBe(true);
    expect(listedRequests.some(url => /\/engines\/dotnet\/_framework\/.+\.wasm$/.test(url))).toBe(true);
    expect(grammar.length).toBeGreaterThanOrEqual(1);
    expect(listedRequests.filter(url => grammar.includes(url))).toEqual([]);
}, testTimeoutMs * 2);

test("Show IL to the Side in Painter's menu opens Painter.il beside Painter.cs with the theme's opcode color", async () => {
    const { page, violations, requests } = await openWorkbench();
    await openPainter(page);
    await expandRows(page, 'Painter');

    await findRow(page, 'Painter').click({ button: 'right' });
    await pickMenuItem(page, 'Show IL to the Side');
    const ilTab = page.locator('.tab .label-name').getByText('Painter.il', { exact: true });
    await ilTab.waitFor();
    await page.locator('.editor-group-container').filter({ has: ilTab }).locator('.view-line').first().click();
    const rowTexts = await readRowTexts(page);

    expect(await readUntil(() => readWordColor(page, 'IL_0001: ldfld', 'ldfld'), '#609fd2')).toBe('#609fd2');
    expect(rowTexts).toContain('Count');
    expect(rowTexts.filter(text => /get_Count|k__BackingField|<Steps>d__11/.test(text))).toEqual([]);
    expect(requests.filter(url => /il\.tmLanguage/.test(url)).length).toBeGreaterThanOrEqual(1);
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, testTimeoutMs * 2);
