import { sampleFiles } from '#contract/fake';
import type { WorkerRequest } from '#contract/serve';
import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import {
    aboutTab,
    countCursors,
    findWord,
    openCircle,
    readActiveTab,
    readCursor,
    readHover,
    readReferences,
    readTabs,
    readUntil,
    waitForTabs,
} from './editor-testing';
import { collectErrors, startWorkbench, testTimeoutMs, waitForEngineReplies } from './page-testing';
import { dropAndWait, dropFiles, expandRows, findPaneHeader, findRow, startWithEngines } from './tree-testing';

const openWorkbench = startWorkbench();
const drawing = await sampleFiles.drawing.text();
const shapes = await sampleFiles.shapes.text();
const craftedName = '**B**<i>[x](command:decomp.close)</i>';
const crafted = `fake\nnamespace N\n public class ${craftedName}\n  public method Run\n   uses <b>w</b>.fake|X.Y\n`;

/**
 * Serves an engine whose class `Listed`, with the key 2, has a document that declares the local `count` on line 2, uses
 * the local on line 3 and declares the method `Deep` of the class `Inner` in `Listed` on line 4 without a declaration
 * of `Inner`. Line 5 uses `Listed`, line 6 a symbol whose description has a fence and line 7 a symbol whose `describe`
 * and `resolve` calls the engine refuses. The engine doesn't describe `Listed`.
 */
function serveListedEngine() {
    onmessage = function ({ data }: MessageEvent<WorkerRequest>) {
        // ignores a cancel message because the engine finishes each call
        if ('cancel' in data) {
            return;
        }

        const { method, args } = data;
        const [fileId] = args;
        // line -> the line's token: its word, kind, flags and target, with 16 for the modifier `declaration`
        const lines: [line: string, word: string, kind: number, flags: number, target: string][] = [
            ['class Listed', 'Listed', 1, 16, `${fileId}:2`],
            ['    var count', 'count', 15, 16, 'L:0'],
            ['    use count', 'count', 15, 0, 'L:0'],
            ['        method Deep', 'Deep', 6, 16, `${fileId}:4`],
            ['    use Listed', 'Listed', 1, 0, `${fileId}:2`],
            ['    use fenced', 'fenced', 6, 0, '|fenced'],
            ['    use refused', 'refused', 6, 0, '|refused'],
        ];
        const tokens: number[] = [];
        const targets: string[] = [];
        let text = '';
        for (const [line, word, kind, flags, target] of lines) {
            targets.push(...(targets.includes(target) ? [] : [target]));
            tokens.push(text.length + line.indexOf(word), word.length, kind, flags, targets.indexOf(target));
            text += `${line}\n`;
        }

        const fenced = { text: 'first\n ```\n**bold** [link](https://example.com)', container: null, facts: [], missingFile: null };
        // the class `Listed` with the modifier `document`, the class `Inner` in `Listed` and the method `Deep` in
        // `Inner`
        const listing = { values: new Int32Array([1, 32, -1, 2, 0, 1, 0, 0, 3, 0, 6, 0, 1, 4, 0]), names: ['Listed', 'Inner', 'Deep'] };
        const isRefused = fileId === '|refused';
        // method -> the method's reply
        const replies: Record<string, unknown> = {
            claims: { value: true },
            list: { value: { ...listing, details: ['', '', ''], note: '', missingFiles: [] } },
            read: { value: { text, tokens: new Int32Array(tokens), targets, locals: ['var count'] } },
            describe: isRefused ? { error: "The engine can't describe refused." } : { value: fileId === '|fenced' ? fenced : null },
            resolve: isRefused ? { error: "The engine can't resolve refused." } : { value: null },
        };
        postMessage({ reply: replies[method] ?? { value: undefined } });
    };

    postMessage({ ready: true });
}

const listedEngine = { extensions: ['.test'], serve: serveListedEngine };

async function openListed(page: Page) {
    await dropFiles(page, { 'listed.test': '' });
    await expandRows(page, 'listed.test');
    await findRow(page, 'Listed').click();
    await waitForTabs(page, 'About', 'Listed.code');
}

async function openCircleWithShapes(page: Page) {
    await dropAndWait(page, { 'shapes.fake': shapes });
    await openCircle(page, drawing, 'Draw');
}

function readOutline(page: Page): Promise<string[]> {
    return page.locator('.outline-pane .monaco-list-row').evaluateAll(rows => {
        const sorted = (rows as HTMLElement[]).sort((first, second) => Number(first.dataset.index) - Number(second.dataset.index));

        return sorted.map(row => `${row.ariaLevel} ${row.querySelector('.label-name')?.textContent}`);
    });
}

test("hover on `Area` in `Circle.code` shows the method's declaration, `in Shapes.Shape` and the facts on 1 line", async () => {
    const { page } = await openWorkbench();

    await openCircleWithShapes(page);

    expect(await readHover(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area')).toEqual([
        'public abstract method Area',
        'in Shapes.Shape',
        'file shapes.fake · key 3',
    ]);
}, testTimeoutMs);

test("hover on a local shows the local's declaration from the document", async () => {
    const { page } = await openWorkbench();

    await openCircle(page, drawing, 'Draw');

    expect(await readHover(page, 'var area', 'area')).toEqual(['var area']);
}, testTimeoutMs);

test("hover on a symbol of a file that isn't open shows that the file isn't loaded", async () => {
    const { page } = await openWorkbench();

    await openCircle(page, drawing, 'Draw');

    expect(await readHover(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area')).toEqual([
        'Shapes.Shape.Area',
        "shapes.fake isn't loaded. Click here to load.",
    ]);
}, testTimeoutMs);

test('hover shows markdown and HTML in names as plain text', async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'crafted.fake': crafted });
    await expandRows(page, 'crafted.fake', 'N');

    await findRow(page, craftedName).click();

    expect(await readHover(page, 'public method Run', 'Run')).toEqual([
        'public method Run',
        `in N.${craftedName}`,
        'file crafted.fake · key 3',
    ]);
    expect(await readHover(page, 'uses X.Y', 'X.Y')).toEqual(['X.Y', "<b>w</b>.fake isn't loaded. Click here to load."]);
}, testTimeoutMs);

test('hover shows a description with an indented fence in the text as plain text', async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { listed: listedEngine });
    await openListed(page);

    expect(await readHover(page, 'use fenced', 'fenced')).toEqual(['first', ' ```', '**bold** [link](https://example.com)']);
}, testTimeoutMs);

test("hover on a symbol whose description the engine refuses shows the refusal's text and doesn't log an error", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await startWithEngines(page, { listed: listedEngine });
    await openListed(page);

    expect(await readHover(page, 'use refused', 'refused')).toEqual(["The engine can't describe refused."]);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("hover doesn't show for a symbol that the engine doesn't describe", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { listed: listedEngine });
    await openListed(page);

    await findWord(page, 'class Listed', 'Listed').hover();
    // waits for the description because a hover would show then
    await waitForEngineReplies(page, 'describe');

    expect(await page.locator('.monaco-editor .monaco-hover-content').filter({ visible: true }).count()).toBe(0);
    expect(await readHover(page, 'use count', 'count')).toEqual(['var count']);
}, testTimeoutMs);

test("F12 on a symbol of another file opens that file's document at the declaration", async () => {
    const { page } = await openWorkbench();
    await openCircleWithShapes(page);

    await findWord(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area').click();
    await page.keyboard.press('F12');

    expect(await readUntil(() => readActiveTab(page), 'Shape.code')).toBe('Shape.code');
    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 28')).toBe('Ln 2, Col 28');
}, testTimeoutMs);

test('F12 on a use of a member that the first view hides opens the ops document at the member', async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'box.fake': 'fake\nclass Box\n hidden private field backing\n public method Get\n  uses box.fake|Box.backing\n' });
    await expandRows(page, 'box.fake', 'Box');
    await findRow(page, 'Get').click();
    await waitForTabs(page, 'About', 'Box.code');

    await findWord(page, 'uses Box.backing', 'Box.backing').click();
    await page.keyboard.press('F12');

    expect(await readUntil(() => readActiveTab(page), 'Box.ops')).toBe('Box.ops');
    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 20')).toBe('Ln 2, Col 20');
}, testTimeoutMs);

test("Ctrl+click on a symbol of another file opens that file's document at the declaration with 1 cursor", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await openCircleWithShapes(page);

    await findWord(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area').click({ modifiers: ['Control'] });

    expect(await readUntil(() => readActiveTab(page), 'Shape.code')).toBe('Shape.code');
    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 28')).toBe('Ln 2, Col 28');
    expect(await countCursors(page)).toBe(1);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("F12 inside a symbol's name on the symbol's declaration lists the symbol's references", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await findWord(page, 'field radius', 'radius').click();
    await page.keyboard.press('F12');

    const expected = ['readonly field radius', 'uses Drawing.Circle.radius'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
}, testTimeoutMs);

test("F12 on a local goes to the local's declaration in the same document", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { listed: listedEngine });
    await openListed(page);

    await findWord(page, 'use count', 'count').click();
    await page.keyboard.press('F12');

    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 9')).toBe('Ln 2, Col 9');
    expect(await readTabs(page)).toEqual([aboutTab, { label: 'Listed.code', isPreview: true }]);
}, testTimeoutMs);

test("F12 on a symbol stays in the symbol's engine when another engine has a file with the same id", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { fake: null, listed: listedEngine });
    await dropAndWait(page, { 'drawing.fake': drawing });
    await openListed(page);

    await findWord(page, 'use Listed', 'Listed').click();
    await page.keyboard.press('F12');

    expect(await readUntil(() => readCursor(page), 'Ln 1, Col 7')).toBe('Ln 1, Col 7');
    expect(await readTabs(page)).toEqual([aboutTab, { label: 'Listed.code', isPreview: true }]);
}, testTimeoutMs);

test("F12 on a symbol of a file that isn't open stays in place and doesn't log an error", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await openCircle(page, drawing, 'Draw');
    await findWord(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area').click();
    await page.locator('.statusbar-item').filter({ hasText: /^Ln 7, Col \d+$/ }).waitFor();
    const cursor = await readCursor(page);

    await page.keyboard.press('F12');
    // waits for the definition's search because a definition would open its document then
    await waitForEngineReplies(page, 'resolve');

    expect(await readTabs(page)).toEqual([aboutTab, { label: 'Circle.code', isPreview: true }]);
    expect(await readCursor(page)).toBe(cursor);
    expect(errors).toEqual([]);
    await findWord(page, 'uses Drawing.Circle.radius', 'Drawing.Circle.radius').click();
    await page.keyboard.press('F12');
    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 28')).toBe('Ln 2, Col 28');
}, testTimeoutMs);

test("F12 on a symbol whose `resolve` call the engine refuses stays in place and doesn't log an error", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await startWithEngines(page, { listed: listedEngine });
    await openListed(page);
    await findWord(page, 'use refused', 'refused').click();
    await page.locator('.statusbar-item').filter({ hasText: /^Ln 7, Col \d+$/ }).waitFor();
    const cursor = await readCursor(page);

    await page.keyboard.press('F12');
    // waits for the definition's search because a definition would move the cursor then
    await waitForEngineReplies(page, 'resolve');

    expect(await readCursor(page)).toBe(cursor);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("Outline lists the document row's members nested below the document row", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await findPaneHeader(page, 'Outline').click();

    const expected = ['1 Circle', '2 radius', '2 Circle', '2 Draw', '2 Color', '3 Red'];
    expect(await readUntil(() => readOutline(page), expected)).toEqual(expected);
}, testTimeoutMs);

test('Outline follows the cursor into the member whose lines have the cursor', async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');
    await findPaneHeader(page, 'Outline').click();
    await page.locator('.outline-pane .monaco-list-row').first().waitFor();
    await findPaneHeader(page, 'Outline').getByRole('button', { name: 'More Actions...' }).click();
    await page.locator('.context-view .action-label').filter({ hasText: 'Follow Cursor' }).click();

    await findWord(page, 'var area', 'area').click();

    const readSelected = () => page.locator('.outline-pane .monaco-list-row.selected .label-name').allTextContents();
    expect(await readUntil(readSelected, ['Draw'])).toEqual(['Draw']);
}, testTimeoutMs);

test("Outline nests a member below the nearest row with a declaration when the document lacks a row's declaration", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { listed: listedEngine });
    await openListed(page);

    await findPaneHeader(page, 'Outline').click();

    expect(await readUntil(() => readOutline(page), ['1 Listed', '2 Deep'])).toEqual(['1 Listed', '2 Deep']);
}, testTimeoutMs);

test('Symbols view is above the Outline view in the Explorer', async () => {
    const { page } = await openWorkbench();

    const symbolsBox = await findPaneHeader(page, 'Symbols').boundingBox();
    const outlineBox = await findPaneHeader(page, 'Outline').boundingBox();

    expect(symbolsBox!.y).toBeLessThan(outlineBox!.y);
}, testTimeoutMs);
