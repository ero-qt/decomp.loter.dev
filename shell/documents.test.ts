import { expect, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { fakeManifest, sampleFiles } from '#contract/fake';
import { aboutTab, closeTab, openCircle, readCursor, readLines, readTabs, readUntil, readWordColor, waitForTabs } from './editor-testing';
import {
    countEngineCancels,
    findOpenFilesButton,
    listOtherHostRequests,
    startWorkbench,
    testTimeoutMs,
    waitForEngineCalls,
    waitForEngineReplies,
} from './page-testing';
import { dropAndWait, dropFiles, expandRows, findProgressStrip, findRow, findRows, startWithEngines, testEngine } from './tree-testing';

const openWorkbench = startWorkbench();
const drawing = await sampleFiles.drawing.text();
const shapes = await sampleFiles.shapes.text();
const user = 'fake\nnamespace N\n public class User\n  public interface Inner\n  public method Run\n   uses lib.fake|L.Thing\n';

async function startTestEngine(page: Page, files: Record<string, string>) {
    await startWithEngines(page, { test: testEngine });
    await dropFiles(page, files);
    for (const name of Object.keys(files)) {
        await expandRows(page, name);
    }
}

// finds `Listed` by the place of its file because each file of the test engine has the row `Listed`
function findListed(page: Page, fileIndex: number): Locator {
    return findRows(page).filter({ hasText: /^Listed$/ }).nth(fileIndex);
}

test('click on `Draw` opens `Circle.code` in the preview tab with the cursor on `Draw`', async () => {
    const { page, violations, requests } = await openWorkbench();

    await openCircle(page, drawing, 'Draw');

    expect(await readTabs(page)).toEqual([aboutTab, { label: 'Circle.code', isPreview: true }]);
    expect(await readUntil(() => readCursor(page), 'Ln 5, Col 19')).toBe('Ln 5, Col 19');
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, testTimeoutMs);

test("click on another file's class replaces the preview tab", async () => {
    const { page } = await openWorkbench();
    // waits for both files because the tree draws its rows again when a file opens
    await dropAndWait(page, { 'drawing.fake': drawing, 'shapes.fake': shapes });
    await expandRows(page, 'shapes.fake', 'Shapes', 'drawing.fake', 'Drawing', 'Circle');
    await findRow(page, 'Draw').click();
    await waitForTabs(page, 'About', 'Circle.code');

    await findRow(page, 'Shape').click();
    await waitForTabs(page, 'About', 'Shape.code');

    expect(await readTabs(page)).toEqual([aboutTab, { label: 'Shape.code', isPreview: true }]);
    expect(await readUntil(() => readCursor(page), 'Ln 1, Col 23')).toBe('Ln 1, Col 23');
}, testTimeoutMs);

test("double-click on `Draw` opens `Circle.code` in a kept tab that a later click on another file's class doesn't replace", async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'drawing.fake': drawing, 'shapes.fake': shapes });
    await expandRows(page, 'shapes.fake', 'Shapes', 'drawing.fake', 'Drawing', 'Circle');

    await findRow(page, 'Draw').dblclick();

    const kept = [aboutTab, { label: 'Circle.code', isPreview: false }];
    expect(await readUntil(() => readTabs(page), kept)).toEqual(kept);
    await findRow(page, 'Shape').click();
    await waitForTabs(page, 'About', 'Circle.code', 'Shape.code');
    expect(await readTabs(page)).toEqual([...kept, { label: 'Shape.code', isPreview: true }]);
}, testTimeoutMs);

test("click on a nested type opens the outer type's document with the cursor on the nested type", async () => {
    const { page } = await openWorkbench();

    await openCircle(page, drawing, 'Color');

    expect(await readUntil(() => readCursor(page), 'Ln 9, Col 18')).toBe('Ln 9, Col 18');
}, testTimeoutMs);

test("class name and method name in a document have the theme's colors", async () => {
    const { page } = await openWorkbench();

    await openCircle(page, drawing, 'Draw');

    expect(await readUntil(() => readWordColor(page, 'class Circle', 'Circle'), '#56c9a2')).toBe('#56c9a2');
    expect(await readUntil(() => readWordColor(page, 'method Draw', 'Draw'), '#dcd2a5')).toBe('#dcd2a5');
}, testTimeoutMs);

test("document has the language of the engine's first view", async () => {
    const { page } = await openWorkbench();
    const views = [{ ...fakeManifest.views[0], language: 'fake-code' }];
    await page.route('**/engines/fake/manifest.json', route => route.fulfill({ json: { ...fakeManifest, views } }));
    await page.reload();
    await findOpenFilesButton(page).waitFor();

    await openCircle(page, drawing, 'Draw');

    await page.locator('.statusbar-item').filter({ hasText: /^fake-code$/ }).waitFor();
}, testTimeoutMs);

test("click on a namespace doesn't open a document", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake');

    await findRow(page, 'Drawing').click();
    await expandRows(page, 'Drawing');
    await findRow(page, 'Circle').click();
    await waitForTabs(page, 'About', 'Circle.code');

    expect(await readTabs(page)).toEqual([aboutTab, { label: 'Circle.code', isPreview: true }]);
}, testTimeoutMs);

test("document shows the engine's error text with the cursor at the start when the engine refuses the document", async () => {
    const { page, violations } = await openWorkbench();
    await startTestEngine(page, { 'refusing.test': '' });

    await findRow(page, 'Listed').click();
    await waitForTabs(page, 'About', 'Listed.code');

    const errorLines = ["The test engine can't write Listed's document in read 1."];
    expect(await readUntil(() => readLines(page), errorLines)).toEqual(errorLines);
    expect(await readUntil(() => readCursor(page), 'Ln 1, Col 1')).toBe('Ln 1, Col 1');
    expect(violations).toEqual([]);
}, testTimeoutMs);

test("click on a refused document's row reads the document again, after 1 read for the first click", async () => {
    const { page } = await openWorkbench();
    await startTestEngine(page, { 'refusing.test': '' });
    await findRow(page, 'Listed').click();
    await waitForTabs(page, 'About', 'Listed.code');
    await readUntil(() => readCursor(page), 'Ln 1, Col 1');

    await findRow(page, 'Listed').click();

    const lines = ['refusing.test read 2', 'class Listed', ''];
    expect(await readUntil(() => readLines(page), lines)).toEqual(lines);
}, testTimeoutMs);

test("open document stays in the tab after a later click on the document's row and an earlier click's slower read", async () => {
    const { page } = await openWorkbench();
    await startTestEngine(page, { 'early.test': '', 'late.test': '' });
    const lines = ['early.test read 1', 'class Listed', ''];
    await findListed(page, 0).click();
    await readUntil(() => readLines(page), lines);

    await findListed(page, 1).click();
    await waitForEngineCalls(page, 'read', 2);
    await findListed(page, 0).click();
    // waits for the late document's read because the late document would replace the early document then
    await waitForEngineReplies(page, 'read', 2);

    expect(await readLines(page)).toEqual(lines);
}, testTimeoutMs);

test("Symbols view's progress strip runs during a clicked row's read and stops after the document's tab opens", async () => {
    const { page } = await openWorkbench();
    await startTestEngine(page, { 'late.test': '' });
    await readUntil(() => findProgressStrip(page).isVisible(), false);

    await findRow(page, 'Listed').click();
    const isRunning = await readUntil(() => findProgressStrip(page).isVisible(), true);
    await waitForTabs(page, 'About', 'Listed.code');

    expect(isRunning).toBe(true);
    expect(await readUntil(() => findProgressStrip(page).isVisible(), false)).toBe(false);
}, testTimeoutMs);

test("file that closes during its document's read doesn't get a tab", async () => {
    const { page } = await openWorkbench();
    await startTestEngine(page, { 'late.test': '' });

    await findRow(page, 'Listed').click();
    await findRow(page, 'late.test').click();
    await page.keyboard.press('Delete');
    // waits for the document's read because the document's tab would open then
    await waitForEngineReplies(page, 'read');

    expect(await readTabs(page)).toEqual([aboutTab]);
}, testTimeoutMs);

test('close of a tab whose document the engine still writes sends cancel to the engine', async () => {
    const { page } = await openWorkbench();
    await startTestEngine(page, { 'stuck.test': '' });
    await findRow(page, 'Listed').click();
    await waitForTabs(page, 'About', 'Listed.code');
    // opens another file of the engine because the engine's files depend on each other, so the tab's document is read
    // again
    await dropFiles(page, { 'other.test': '' });
    await waitForEngineCalls(page, 'read', 2);

    await closeTab(page, 'Listed.code');

    expect(await readUntil(() => countEngineCancels(page), 1)).toBe(1);
}, testTimeoutMs);

test("click on a row while another file opens puts the cursor on the row's declaration", async () => {
    const { page } = await openWorkbench();
    await startTestEngine(page, { 'listed.test': '' });
    await dropFiles(page, { 'delayed.test': '' });
    await waitForEngineCalls(page, 'open', 2);

    await findRow(page, 'Listed').click();
    await waitForTabs(page, 'About', 'Listed.code');

    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 7')).toBe('Ln 2, Col 7');
}, testTimeoutMs);

test("open document keeps its text while a file's close cancels the document's read", async () => {
    const { page } = await openWorkbench();
    await startTestEngine(page, { 'late.test': '', 'other.test': '' });
    await findListed(page, 0).click();
    await readUntil(() => readLines(page), ['late.test read 1', 'class Listed', '']);
    await findRow(page, 'other.test').click();
    // opens a third file because the engine's files depend on each other, so the tab's document is read again
    await dropFiles(page, { 'third.test': '' });
    await waitForEngineCalls(page, 'read', 2);

    await page.keyboard.press('Delete');

    const firstLines = new Set<string>();
    const lines = ['late.test read 3', 'class Listed', ''];
    await readUntil(async () => {
        const read = await readLines(page);
        firstLines.add(read[0]);

        return read;
    }, lines);
    expect([...firstLines]).toEqual(['late.test read 1', 'late.test read 3']);
}, testTimeoutMs);

test('document is read again after its preview tab closes', async () => {
    const { page } = await openWorkbench();
    await startTestEngine(page, { 'first.test': '', 'second.test': '' });
    await findListed(page, 0).click();
    await readUntil(() => readLines(page), ['first.test read 1', 'class Listed', '']);
    await findListed(page, 1).click();
    await readUntil(() => readLines(page), ['second.test read 2', 'class Listed', '']);

    await findListed(page, 0).click();

    const lines = ['first.test read 3', 'class Listed', ''];
    expect(await readUntil(() => readLines(page), lines)).toEqual(lines);
}, testTimeoutMs);

test("open document gives a symbol the color of the symbol's kind once the symbol's file opens", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'user.fake': user });
    await expandRows(page, 'user.fake', 'N', 'User');
    await findRow(page, 'Run').click();
    await waitForTabs(page, 'About', 'User.code');
    await readUntil(() => readWordColor(page, 'method Run', 'Run'), '#dcd2a5');
    const interfaceColor = await readWordColor(page, 'interface Inner', 'Inner');
    const methodColor = await readWordColor(page, 'uses L.Thing', 'L.Thing');

    await dropFiles(page, { 'lib.fake': 'fake\nnamespace L\n public interface Thing\n' });

    expect(methodColor).not.toBe(interfaceColor);
    expect(await readUntil(() => readWordColor(page, 'uses L.Thing', 'L.Thing'), interfaceColor)).toBe(interfaceColor);
}, testTimeoutMs);

test("open document takes back a symbol's color once the symbol's file closes", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'user.fake': user });
    await expandRows(page, 'user.fake', 'N', 'User');
    await findRow(page, 'Run').click();
    await waitForTabs(page, 'About', 'User.code');
    await readUntil(() => readWordColor(page, 'method Run', 'Run'), '#dcd2a5');
    const interfaceColor = await readWordColor(page, 'interface Inner', 'Inner');
    const outsideColor = await readWordColor(page, 'uses L.Thing', 'L.Thing');
    await dropFiles(page, { 'lib.fake': 'fake\nnamespace L\n public interface Thing\n' });
    await readUntil(() => readWordColor(page, 'uses L.Thing', 'L.Thing'), interfaceColor);

    await findRow(page, 'lib.fake').click();
    await page.keyboard.press('Delete');

    expect(outsideColor).not.toBe(interfaceColor);
    expect(await readUntil(() => readWordColor(page, 'uses L.Thing', 'L.Thing'), outsideColor)).toBe(outsideColor);
}, testTimeoutMs);

test("closing a file closes the file's documents", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await findRow(page, 'drawing.fake').click();
    await page.keyboard.press('Delete');
    await waitForTabs(page, 'About');

    expect(await readTabs(page)).toEqual([aboutTab]);
}, testTimeoutMs);
