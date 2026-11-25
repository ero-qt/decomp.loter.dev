import { sampleFiles } from '#contract/fake';
import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { readActiveTab, readCursor, readResults, readUntil } from './editor-testing';
import { startWorkbench, testTimeoutMs } from './page-testing';
import { dropAndWait, findPaneHeader } from './tree-testing';

const openWorkbench = startWorkbench();
const drawing = await sampleFiles.drawing.text();
const shapes = await sampleFiles.shapes.text();

// opens the picker anew for each query because a query then starts from an empty box
async function search(page: Page, query: string) {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+F');
    await page.keyboard.insertText(query);
}

async function find(page: Page, query: string, expected: string[]): Promise<string[]> {
    await search(page, query);

    return readUntil(async () => (await readResults(page)).sort(), expected.toSorted());
}

test('Ctrl+Shift+F `Area` lists the method of shapes.fake, and Enter opens `Shape.code` at `Area`', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'drawing.fake': drawing, 'shapes.fake': shapes });

    const expected = ['symbol-method Area Shape • shapes.fake'];
    expect(await find(page, 'Area', expected)).toEqual(expected);
    await page.keyboard.press('Enter');

    expect(await readUntil(() => readActiveTab(page), 'Shape.code')).toBe('Shape.code');
    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 28')).toBe('Ln 2, Col 28');
}, testTimeoutMs);

test('the search button of the Symbols view opens the picker, which tells its filters', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'shapes.fake': shapes });

    await findPaneHeader(page, 'Symbols').hover();
    await page.getByRole('button', { name: 'Search Symbols and Strings...' }).click();

    const placeholder = await page.locator('.quick-input-box input').getAttribute('placeholder');
    expect(placeholder).toContain('kind:method');
    expect(await readResults(page)).toEqual([]);
}, testTimeoutMs);

test('kind:, is: and in: filter the results, also without a name', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'drawing.fake': drawing, 'shapes.fake': shapes });
    const circle = 'symbol-class Circle Drawing • drawing.fake';
    const shape = 'symbol-class Shape Shapes • shapes.fake';
    const area = 'symbol-method Area Shape • shapes.fake';
    const draw = 'symbol-method Draw Circle • drawing.fake';

    for (const [query, expected] of [
        ['kind:class', [circle, shape]],
        ['is:abstract', [shape, area]],
        ['is:private', ['symbol-enum Color Circle • drawing.fake', 'symbol-field radius Circle • drawing.fake']],
        ['kind:enum_member', ['symbol-enum-member Red Color • drawing.fake']],
        ['in:shapes kind:method', [area]],
        ['kind:method circle.', [draw]],
        ['kind:method,constructor is:public a', [area, draw]],
        ['kind:method nothing', []],
    ] as const) {
        expect([query, await find(page, query, [...expected])]).toEqual([query, expected.toSorted()]);
    }
}, testTimeoutMs);

test('the picker lists the best match first, also when a worse match comes first by name, and shows markdown as plain text', async () => {
    const { page } = await openWorkbench();
    const name = '**B**<i>[x](command:decomp.close)</i>$(zap)';
    const classes = [name, 'AGetB', 'GetBox', 'Get'].map(found => ` public class ${found}\n`).join('');
    await dropAndWait(page, { 'crafted.fake': `fake\nnamespace N\n${classes}` });

    await search(page, 'get');
    const sorted = ['symbol-class Get N • crafted.fake', 'symbol-class GetBox N • crafted.fake', 'symbol-class AGetB N • crafted.fake'];
    expect(await readUntil(() => readResults(page), sorted)).toEqual(sorted);

    const crafted = [`symbol-class ${name} N • crafted.fake`];
    expect(await find(page, 'command', crafted)).toEqual(crafted);
    expect(await page.locator('.quick-input-list b, .quick-input-list i, .quick-input-list .codicon-zap').count()).toBe(0);
}, testTimeoutMs);

test('a quote lists the strings, and Enter opens the document of a string\'s user with the cursor on the string', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'drawing.fake': drawing });

    const expected = ['symbol-string "circle" Draw • drawing.fake'];
    expect(await find(page, '"cir', expected)).toEqual(expected);
    await page.keyboard.press('Enter');

    expect(await readUntil(() => readActiveTab(page), 'Circle.code')).toBe('Circle.code');
    expect(await readUntil(() => readCursor(page), 'Ln 8, Col 17')).toBe('Ln 8, Col 17');
}, testTimeoutMs);

test('a string without a known user shows up, and Enter says that it has none', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'drawing.fake': drawing });

    const expected = ['symbol-string "drawing 1.0" no known user • drawing.fake'];
    expect(await find(page, '"drawing', expected)).toEqual(expected);
    await page.keyboard.press('Enter');

    const message = "drawing.fake has this string, but its engine doesn't know the code that uses it.";
    await page.locator('.notification-list-item-message').getByText(message).waitFor();
}, testTimeoutMs);
