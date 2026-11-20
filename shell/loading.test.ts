import { expect, test } from 'bun:test';
import type { FileChooser, Locator, Page } from 'playwright';
import { sampleFiles } from '../contract/fake';
import type { WorkerRequest } from '../contract/serve';
import { findWord, openCircle, readHover, readLines, readUntil, readWarnings, waitForTabs } from './editor-testing';
import { collectErrors, startWorkbench, testTimeoutMs, waitForEngineCalls, waitForEngineReplies } from './page-testing';
import {
    dropAndWait,
    dropFiles,
    expandRows,
    findRow,
    findRows,
    readRowTexts,
    serveTestEngine,
    startWithEngines,
} from './tree-testing';

const openWorkbench = startWorkbench();
const drawing = await sampleFiles.drawing.text();
const shapes = await sampleFiles.shapes.text();
const craftedName = '[x](command:decomp.close).notes';
const crafted = `fake\nnamespace N\n public class C\n  public method Run\n   uses ${craftedName}|X.Y\n`;
const drawingRows = ['drawing.fake 1 class left out', 'drawing.notes not loaded', 'shapes.fake not loaded', 'Drawing'];

/**
 * Serves an engine that claims each file whose name ends with `.test` and lists a missing companion file with the
 * file's name and the extension `.notes`. The engine crashes on `provide` for a file whose name starts with `crash` and
 * refuses `provide` for any other file.
 */
function serveCompanionEngine() {
    // file's id -> the file's name
    const names = new Map<unknown, string>();
    onmessage = function ({ data }: MessageEvent<WorkerRequest>) {
        // ignores a cancel message because the engine finishes each call
        if ('cancel' in data) {
            return;
        }

        const { method, args } = data;
        if (method === 'open') {
            names.set(args[0], String(args[1]));
        }

        const name = names.get(args[0]) ?? '';
        const missingFiles = [{ name: name.replace(/\.test$/, '.notes'), reason: 'not loaded', isCompanion: true }];
        const listing = { values: new Int32Array(), names: [], details: [], note: '', missingFiles };
        // method -> the method's value
        const values: Record<string, unknown> = { claims: String(args[0]).endsWith('.test'), list: listing, listStrings: [] };
        if (method !== 'provide') {
            postMessage({ reply: { value: values[method] } });
        } else if (name.startsWith('crash')) {
            postMessage({ fatal: 'the test engine crashed' });
        } else {
            postMessage({ reply: { error: `The test engine can't read ${args[1]}.` } });
        }
    };

    postMessage({ ready: true });
}

const companionEngine = { extensions: ['.test'], serve: serveCompanionEngine };

async function openFileDialog(page: Page, element: Locator): Promise<FileChooser> {
    const chooser = page.waitForEvent('filechooser');
    await element.click();

    return chooser;
}

async function pickFile(page: Page, element: Locator, name: string, text: string): Promise<FileChooser> {
    const fileChooser = await openFileDialog(page, element);
    await fileChooser.setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) });

    return fileChooser;
}

async function findLoadLink(page: Page, lineText: string, word: string): Promise<Locator> {
    await findWord(page, lineText, word).hover();
    const hover = page.locator('.monaco-editor .monaco-hover-content').filter({ visible: true });
    await hover.waitFor();

    return hover.getByRole('link', { name: 'Click here to load' });
}

function waitForTopRow(page: Page, name: string) {
    return findRows(page).and(page.locator('[aria-level="1"]')).filter({ hasText: name }).waitFor();
}

test("click on a missing file's row opens the file dialog and opens the picked file", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await pickFile(page, findRow(page, 'shapes.fake'), 'shapes.fake', shapes);
    await waitForTopRow(page, 'shapes.fake');

    const expected = ['public abstract method Area', 'in Shapes.Shape', 'file shapes.fake', 'key 3'];
    expect(await readUntil(() => readHover(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area'), expected)).toEqual(expected);
}, testTimeoutMs);

test("hover's load link opens the file dialog for 1 file with the missing file's extension", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');
    expect(await readHover(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area')).toEqual([
        'Shapes.Shape.Area',
        "shapes.fake isn't loaded. Click here to load.",
    ]);

    const chooser = await pickFile(page, await findLoadLink(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area'), 'shapes.fake', shapes);
    await waitForTopRow(page, 'shapes.fake');

    expect(await chooser.element().getAttribute('accept')).toBe('.fake');
    expect(chooser.isMultiple()).toBe(false);
}, testTimeoutMs);

test("hover's load link loads the missing file of a file whose path has a percent sign and a parenthesis", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'my%20app (1).fake': drawing });
    await expandRows(page, 'my%20app (1).fake', 'Drawing', 'Circle');
    await findRow(page, 'Draw').click();
    await waitForTabs(page, 'Circle.code');

    await pickFile(page, await findLoadLink(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area'), 'shapes.fake', shapes);

    await waitForTopRow(page, 'shapes.fake');
}, testTimeoutMs);

test("missing file's row goes away after the engine gets the picked companion", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await dropFiles(page, { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake');

    await pickFile(page, findRow(page, 'drawing.notes'), 'drawing.notes', 'A note.');

    const expected = ['drawing.fake 1 class left out', 'shapes.fake not loaded', 'Drawing'];
    expect(await readUntil(() => readRowTexts(page), expected)).toEqual(expected);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("engine gets a picked companion under the missing file's name when the file has another name", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake');

    const chooser = await pickFile(page, findRow(page, 'drawing.notes'), 'drawing_v2.notes', 'A note.');

    const expected = ['drawing.fake 1 class left out', 'shapes.fake not loaded', 'Drawing'];
    expect(await readUntil(() => readRowTexts(page), expected)).toEqual(expected);
    expect(await chooser.element().getAttribute('accept')).toBe('.notes');
}, testTimeoutMs);

test('engine gets a picked companion that another engine claims', async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { fake: null, notes: { extensions: ['.notes'], serve: serveTestEngine } });
    await dropFiles(page, { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake');

    await pickFile(page, findRow(page, 'drawing.notes'), 'drawing.notes', 'A note.');

    const expected = ['drawing.fake 1 class left out', 'shapes.fake not loaded', 'Drawing'];
    expect(await readUntil(() => readRowTexts(page), expected)).toEqual(expected);
    await waitForEngineCalls(page, 'provide');
}, testTimeoutMs);

test("open document of a file shows a picked companion's effect without a new click", async () => {
    const { page } = await openWorkbench();
    await openCircle(page, drawing, 'Draw');

    await pickFile(page, findRow(page, 'drawing.notes'), 'drawing_v2.notes', 'A note.');

    expect(await readUntil(async () => (await readLines(page)).includes('notes drawing.notes'), true)).toBe(true);
}, testTimeoutMs);

test("file's row shows the engine's refusal text for a picked companion without a logged error", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { companion: companionEngine });
    const errors = collectErrors(page);
    await dropFiles(page, { 'refusing.test': '' });
    await expandRows(page, 'refusing.test');

    await pickFile(page, findRow(page, 'refusing.notes'), 'refusing.notes', 'A note.');

    const expected = ["refusing.test The test engine can't read refusing.notes.", 'refusing.notes not loaded'];
    expect(await readUntil(() => readRowTexts(page), expected)).toEqual(expected);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("file's row keeps the engine's refusal text after another file opens", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { companion: companionEngine });
    await dropFiles(page, { 'refusing.test': '' });
    await expandRows(page, 'refusing.test');
    const refusal = "The test engine can't read refusing.notes.";
    await pickFile(page, findRow(page, 'refusing.notes'), 'refusing.notes', 'A note.');
    await findRow(page, 'refusing.test').locator('.label-description').filter({ hasText: refusal }).waitFor();

    await dropAndWait(page, { 'other.test': '' });
    // waits for the file's new listing because the tree takes the file's row's text from the listing
    await waitForEngineReplies(page, 'list', 3);

    const expected = ['other.test', `refusing.test ${refusal}`, 'refusing.notes not loaded'];
    expect(await readUntil(() => readRowTexts(page), expected)).toEqual(expected);
}, testTimeoutMs);

test("file's row shows the crash text after the engine crashes on a picked companion and logs 1 error", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { companion: companionEngine });
    const errors = collectErrors(page);
    await dropFiles(page, { 'crash.test': '' });
    await expandRows(page, 'crash.test');

    await pickFile(page, findRow(page, 'crash.notes'), 'crash.notes', 'A note.');

    const expected = ['crash.test The engine crashed while it added the file.', 'crash.notes not loaded'];
    expect(await readUntil(() => readRowTexts(page), expected)).toEqual(expected);
    expect(errors).toHaveLength(1);
}, testTimeoutMs);

test('canceled file dialog of a missing file leaves the open files as they were', async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await dropFiles(page, { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake');

    await (await openFileDialog(page, findRow(page, 'drawing.notes'))).setFiles([]);
    await dropAndWait(page, { 'other.fake': 'fake\n' });

    expect(await readUntil(() => readRowTexts(page), [...drawingRows, 'other.fake'])).toEqual([...drawingRows, 'other.fake']);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("picked missing file of a file that closed before the pick doesn't open", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await dropFiles(page, { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake');
    const fileChooser = await openFileDialog(page, findRow(page, 'shapes.fake'));
    await findRow(page, 'drawing.fake').click();
    await page.keyboard.press('Delete');
    await findRow(page, 'drawing.fake').waitFor({ state: 'detached' });

    await fileChooser.setFiles({ name: 'shapes.fake', mimeType: 'application/octet-stream', buffer: Buffer.from(shapes) });
    await dropAndWait(page, { 'other.fake': 'fake\n' });

    expect(await readUntil(() => readRowTexts(page), ['other.fake'])).toEqual(['other.fake']);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("hover shows a command link in a missing file's name as text and has only the load link", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'crafted.fake': crafted });
    await expandRows(page, 'crafted.fake', 'N');
    await findRow(page, 'C').click();

    expect(await readHover(page, 'uses X.Y', 'X.Y')).toEqual(['X.Y', `${craftedName} isn't loaded. Click here to load.`]);
    const link = await findLoadLink(page, 'uses X.Y', 'X.Y');
    expect(await page.locator('.monaco-editor .monaco-hover-content a').filter({ visible: true }).count()).toBe(1);
}, testTimeoutMs);

test('file dialog of a missing file without an extension accepts every file', async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'readme.fake': 'fake\nneeds readme\n' });
    await expandRows(page, 'readme.fake');

    const chooser = await pickFile(page, findRow(page, 'readme'), 'readme', 'A text file.');

    expect(await chooser.element().getAttribute('accept')).toBe('');
    expect(await readUntil(() => readRowTexts(page), ['readme.fake'])).toEqual(['readme.fake']);
}, testTimeoutMs);
