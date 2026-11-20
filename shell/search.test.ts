import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { sampleFiles } from '../contract/fake';
import type { WorkerRequest } from '../contract/serve';
import { aboutTab, openCircle, readActiveTab, readCursor, readLines, readTabs, readUntil } from './editor-testing';
import { collectErrors, startWorkbench, testTimeoutMs } from './page-testing';
import { dropAndWait, dropFiles, findRow, readRowTexts, startWithEngines, testEngine } from './tree-testing';

const openWorkbench = startWorkbench();
const drawing = await sampleFiles.drawing.text();
const shapes = await sampleFiles.shapes.text();

/**
 * Serves an engine whose files each list the class `Listed`, which has its own document with the file's name on the
 * first line. Each file has the string `elsewhere`, which `Listed` of the file with the id 1 uses, except a file whose
 * name starts with `bad`, whose string has a user that isn't a target.
 */
function serveStringsEngine() {
    // file's id -> the file's name
    const names = new Map<unknown, string>();

    onmessage = function ({ data }: MessageEvent<WorkerRequest>) {
        // ignores a cancel message because the engine finishes each call
        if ('cancel' in data) {
            return;
        }

        const { method, args } = data;
        const [fileId] = args;
        if (method === 'open') {
            names.set(fileId, String(args[1]));
        }

        const name = names.get(fileId) ?? '';
        const text = `${name}\nclass Listed\n`;
        // method -> the method's value
        const values: Record<string, unknown> = {
            claims: true,
            // the class `Listed` with the modifier `document`
            list: { values: new Int32Array([1, 32, -1, 1, 0]), names: ['Listed'], details: [''], note: '', missingFiles: [] },
            // the token `Listed` with the kind `class` and the modifier `declaration`
            read: { text, tokens: new Int32Array([text.indexOf('Listed'), 6, 1, 16, 0]), targets: [`${fileId}:1`], locals: [] },
            listStrings: [{ text: 'elsewhere', user: name.startsWith('bad') ? 'zz' : '1:1' }],
        };
        postMessage({ reply: { value: values[method] } });
    };

    postMessage({ ready: true });
}

async function searchSymbols(page: Page, query: string) {
    await page.keyboard.press('Control+T');
    await page.keyboard.insertText(query);
}

/** Reads each result's icon, label and description, like `symbol-method Area Shape • shapes.fake`. */
function readResults(page: Page): Promise<string[]> {
    return page.locator('.quick-input-list .monaco-list-row').evaluateAll(rows => rows.map(row => {
        const icon = /codicon-(symbol-[\w-]+)/.exec(row.querySelector('.quick-input-list-icon')?.className ?? '')?.[1];
        const label = row.querySelector('.label-name')?.textContent;
        const description = row.querySelector('.label-description')?.textContent;

        return [icon, label, description].filter(Boolean).join(' ');
    }));
}

async function readSortedResults(page: Page): Promise<string[]> {
    return (await readResults(page)).sort();
}

function readResultCount(page: Page): Promise<string | null> {
    return page.locator('.quick-input-visible-count').textContent();
}

function pickResult(page: Page, label: string) {
    return page.locator('.quick-input-list .monaco-list-row').filter({ has: page.getByText(label, { exact: true }) }).click();
}

function writeClasses(count: number): string {
    return `fake\n${Array.from({ length: count }, (_, index) => `public class Class${index}\n`).join('')}`;
}

test('Ctrl+T `Area` lists the method of shapes.fake and opens `Shape.code` at `Area`', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'drawing.fake': drawing, 'shapes.fake': shapes });

    await searchSymbols(page, 'Area');

    const expected = ['symbol-method Area Shape • shapes.fake'];
    expect(await readUntil(() => readResults(page), expected)).toEqual(expected);
    await pickResult(page, 'Area');
    expect(await readUntil(() => readActiveTab(page), 'Shape.code')).toBe('Shape.code');
    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 28')).toBe('Ln 2, Col 28');
}, testTimeoutMs);

test('Ctrl+T leaves out a row that the first view hides', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'box.fake': 'fake\nclass Box\n hidden private field getter\n public method Get\n' });

    await searchSymbols(page, 'get');

    const expected = ['symbol-method Get Box • box.fake'];
    expect(await readUntil(() => readResults(page), expected)).toEqual(expected);
}, testTimeoutMs);

test('Ctrl+T leaves out a section and the rows in it', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'box.fake': 'fake\nsection Boxes\n reference BoxParts\nclass Box\n' });

    await searchSymbols(page, 'box');

    const expected = ['symbol-class Box box.fake'];
    expect(await readUntil(() => readResults(page), expected)).toEqual(expected);
}, testTimeoutMs);

test('Ctrl+T `circle` lists the string `"circle"` with its user and opens `Circle.code` with the cursor on the string', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'drawing.fake': drawing });

    await searchSymbols(page, 'circle');

    const expected = [
        'symbol-class Circle Drawing • drawing.fake',
        'symbol-constructor Circle Circle • drawing.fake',
        'symbol-string "circle" Draw • drawing.fake',
    ];
    expect(await readUntil(() => readSortedResults(page), expected)).toEqual(expected);
    await pickResult(page, '"circle"');
    expect(await readUntil(() => readActiveTab(page), 'Circle.code')).toBe('Circle.code');
    expect(await readUntil(() => readCursor(page), 'Ln 8, Col 17')).toBe('Ln 8, Col 17');
}, testTimeoutMs);

test('Ctrl+T `"cir` lists only the string `"circle"`', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'drawing.fake': drawing });

    await searchSymbols(page, '"cir');

    const expected = ['symbol-string "circle" Draw • drawing.fake'];
    expect(await readUntil(() => readResults(page), expected)).toEqual(expected);
}, testTimeoutMs);

test('Ctrl+Shift+F opens Go to Symbol in Workspace with the quote that searches the strings', async () => {
    const { page } = await openWorkbench();

    await page.keyboard.press('Control+Shift+F');

    expect(await readUntil(() => page.locator('.quick-input-box input').inputValue(), '#"')).toBe('#"');
}, testTimeoutMs);

test('Ctrl+P after a click on `Draw` lists `Circle.code` above the About tab', async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await page.keyboard.press('Control+P');

    expect(await readUntil(() => readResults(page), ['Circle.code', 'About'])).toEqual(['Circle.code', 'About']);
}, testTimeoutMs);

test("Ctrl+T on a string whose text the document doesn't show opens the document at the declaration of the string's user", async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'quoted.fake': 'fake\nnamespace N\n public class C\n  public method Run\n   string say "hi"\n' });

    await searchSymbols(page, 'say');
    const expected = ['symbol-string "say \\"hi\\"" Run • quoted.fake'];
    expect(await readUntil(() => readResults(page), expected)).toEqual(expected);
    await pickResult(page, '"say \\"hi\\""');

    expect(await readUntil(() => readCursor(page), 'Ln 2, Col 19')).toBe('Ln 2, Col 19');
}, testTimeoutMs);

test("Ctrl+T lists 2 engines' symbols and opens the picked result's document in the result's engine", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { fake: null, test: testEngine });
    await dropAndWait(page, { 'listed.fake': 'fake\nnamespace N\n public class Listed\n', 'one.test': '' });

    await searchSymbols(page, 'Listed');

    const expected = ['symbol-class Listed N • listed.fake', 'symbol-class Listed one.test'];
    expect(await readUntil(() => readSortedResults(page), expected)).toEqual(expected);
    await pickResult(page, 'one.test');
    expect(await readUntil(async () => (await readLines(page))[0], 'one.test read 1')).toBe('one.test read 1');
}, testTimeoutMs);

test('Ctrl+T lists the files with the same name in 2 folders apart', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'first/same.fake': shapes, 'second/same.fake': shapes });

    await searchSymbols(page, 'Area');

    const expected = ['symbol-method Area Shape • first/same.fake', 'symbol-method Area Shape • second/same.fake'];
    expect(await readUntil(() => readSortedResults(page), expected)).toEqual(expected);
}, testTimeoutMs);

test("Ctrl+T result whose file closed before the pick doesn't open a document", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    const broken = "drawing.fake The fake engine can't read the line 'nonsense' of drawing.fake.";
    await dropAndWait(page, { 'drawing.fake': drawing, 'shapes.fake': shapes });
    await searchSymbols(page, 'Draw');
    const drawResults = ['symbol-method Draw Circle • drawing.fake'];
    expect(await readUntil(() => readResults(page), drawResults)).toEqual(drawResults);

    await dropFiles(page, { 'drawing.fake': 'fake\nnonsense\n' });
    expect(await readUntil(() => readRowTexts(page), [broken, 'shapes.fake'])).toEqual([broken, 'shapes.fake']);
    await pickResult(page, 'Draw');
    await searchSymbols(page, 'Area');
    await pickResult(page, 'Area');

    const expected = [aboutTab, { label: 'Shape.code', isPreview: false }];
    expect(await readUntil(() => readTabs(page), expected)).toEqual(expected);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("Ctrl+T searches a file whose row in the Symbols view isn't expanded", async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'drawing.fake': drawing });

    await searchSymbols(page, 'Draw');

    const expected = ['symbol-method Draw Circle • drawing.fake'];
    expect(await readUntil(() => readResults(page), expected)).toEqual(expected);
    expect(await findRow(page, 'drawing.fake').getAttribute('aria-expanded')).toBe('false');
    expect(await readRowTexts(page)).toEqual(['drawing.fake']);
}, testTimeoutMs);

test("Ctrl+T leaves out a file whose listing fails and doesn't log an error", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await startWithEngines(page, { test: testEngine });
    await dropAndWait(page, { 'flaky.test': '', 'one.test': '' });

    await searchSymbols(page, 'Listed');

    expect(await readUntil(() => readResults(page), ['symbol-class Listed one.test'])).toEqual(['symbol-class Listed one.test']);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("Ctrl+T keeps a file's names and logs 1 error when a string's user isn't a target", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await startWithEngines(page, { test: { extensions: ['.test'], serve: serveStringsEngine } });
    await dropAndWait(page, { 'bad.test': '' });

    await searchSymbols(page, 'Listed');

    expect(await readUntil(() => readResults(page), ['symbol-class Listed bad.test'])).toEqual(['symbol-class Listed bad.test']);
    expect(errors).toEqual([expect.stringContaining("the reply of listStrings isn't a list of texts, each with a row target or null")]);
}, testTimeoutMs);

test("Ctrl+T opens a string whose user is in another file at the user in that file's document", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { test: { extensions: ['.test'], serve: serveStringsEngine } });
    await dropAndWait(page, { 'one.test': '', 'two.test': '' });

    await searchSymbols(page, 'elsewhere');

    expect(await readUntil(() => readResults(page), ['symbol-string "elsewhere" Listed • one.test'])).toEqual([
        'symbol-string "elsewhere" Listed • one.test',
    ]);
    await pickResult(page, '"elsewhere"');
    expect(await readUntil(async () => (await readLines(page))[0], 'one.test')).toBe('one.test');
}, testTimeoutMs);

test("Ctrl+T opens a string's document at the string after another file of the engine opened", async () => {
    const { page } = await openWorkbench();
    const expected = ['symbol-string "circle" Draw • drawing.fake'];
    await dropAndWait(page, { 'drawing.fake': drawing });
    await searchSymbols(page, 'circle');
    const circleResults = ['symbol-class Circle Drawing • drawing.fake', 'symbol-constructor Circle Circle • drawing.fake', ...expected];
    expect(await readUntil(() => readResults(page), circleResults)).toEqual(circleResults);
    await page.keyboard.press('Escape');

    await dropAndWait(page, { 'shapes.fake': shapes });
    await searchSymbols(page, '"circle');
    expect(await readUntil(() => readResults(page), expected)).toEqual(expected);
    await pickResult(page, '"circle"');

    expect(await readUntil(() => readCursor(page), 'Ln 8, Col 17')).toBe('Ln 8, Col 17');
}, testTimeoutMs);

test('Ctrl+T shows at most 500 names', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'many.fake': writeClasses(600) });

    await searchSymbols(page, 'Class');

    expect(await readUntil(() => readResultCount(page), '500 Results')).toBe('500 Results');
}, testTimeoutMs);

test('Ctrl+T shows a string next to 500 names', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'many.fake': `${writeClasses(600)}public class Holder\n public method Run\n  string the class\n` });

    await searchSymbols(page, 'Class');

    expect(await readUntil(() => readResultCount(page), '501 Results')).toBe('501 Results');
}, testTimeoutMs);

test('Ctrl+T shows markdown and HTML in names and strings as plain text', async () => {
    const { page } = await openWorkbench();
    const name = '**B**<i>[x](command:decomp.close)</i>$(zap)';
    const text = '<b>s</b> [y](command:decomp.close) $(zap)';
    await dropAndWait(page, { 'crafted.fake': `fake\nnamespace N\n public class ${name}\n  public method Run\n   string ${text}\n` });

    await searchSymbols(page, 'command');

    const expected = [`symbol-class ${name} N • crafted.fake`, `symbol-string ${JSON.stringify(text)} Run • crafted.fake`];
    expect(await readUntil(() => readSortedResults(page), expected)).toEqual(expected);
    expect(await page.locator('.quick-input-list b, .quick-input-list i, .quick-input-list .codicon-zap').count()).toBe(0);
}, testTimeoutMs);
