import { sampleFiles } from '#contract/fake';
import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { aboutTab, findTab, findWord, openCircle, readActiveTab, readTabs, readUntil, readWarnings, waitForTabs } from './editor-testing';
import { collectErrors, findOpenFilesButton, listOtherHostRequests, startWorkbench, testTimeoutMs, waitForEngineReplies } from './page-testing';
import {
    dropAndWait,
    dropFiles,
    expandRows,
    findPaneHeader,
    findRow,
    findRows,
    readRowIcon,
    readRowTexts,
    readRowTooltip,
    readSelectedRows,
    serveTestEngine,
    startWithEngines,
    writeFiles,
} from './tree-testing';

const openWorkbench = startWorkbench();
const drawing = await sampleFiles.drawing.text();
const shapes = await sampleFiles.shapes.text();
const crashText = 'The engine crashed while it opened the file.';
const parts = `fake
namespace Alpha
section Resources
 private resource palette.txt 24 bytes
section References
 reference Shapes 1.0.0.0
public class Zeta
`;

const unsorted = `fake
public class Zeta
namespace Beta
 public class Shape
  public static method Largest
  private field sides
  public field Edges
  public field Corners
namespace Alpha
`;

function listEngineWorkers(page: Page): string[] {
    return page.workers().map(worker => new URL(worker.url()).pathname).filter(pathname => pathname.startsWith('/engines/'));
}

async function chooseFiles(page: Page, button: 'Open Files' | 'Open Folder', files: Record<string, string> | string) {
    const chooser = page.waitForEvent('filechooser');
    // hovers the Symbols view's header because the workbench only shows a view's title buttons on hover while the
    // Explorer has 2 views
    await findPaneHeader(page, 'Symbols').hover();
    await page.getByRole('button', { name: `${button}...` }).click();
    const buffers = Object.entries(files).map(([name, text]) => {
        return { name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) };
    });
    await (await chooser).setFiles(typeof files === 'string' ? files : buffers);
}

async function closeWithMenu(page: Page, label: string) {
    await findRow(page, label).click({ button: 'right' });
    // picks the item with the keyboard once the menu shows the item as focused because the menu can miss an early click
    await page.getByRole('menuitem', { name: 'Close' }).hover();
    await page.locator('.context-view .action-item.focused').waitFor();
    await page.keyboard.press('Enter');
    await findRow(page, label).waitFor({ state: 'detached' });
}

// waits for the worker's stop because an engine keeps the worker while the engine has an open file
async function closeLastFile(page: Page, label: string) {
    await findRow(page, label).click();
    const stopped = page.workers()[0].waitForEvent('close');
    await page.keyboard.press('Delete');
    await stopped;
}

test("Symbols view lists a dropped fake file's namespace, class and members", async () => {
    const { page, violations, requests } = await openWorkbench();

    await dropFiles(page, { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake', 'Drawing', 'Circle');

    expect((await readRowTexts(page)).slice(-6)).toEqual(['Drawing', 'Circle', 'Color', 'radius', 'Circle', 'Draw']);
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, testTimeoutMs);

test("symbol's row has a place by kind and name, a tooltip and an icon with the symbol's marks", async () => {
    const { page, violations } = await openWorkbench();

    await dropFiles(page, { 'unsorted.fake': unsorted });
    await expandRows(page, 'unsorted.fake', 'Beta', 'Shape');
    const icons = await Promise.all(['Corners', 'Edges', 'sides', 'Largest'].map(label => readRowIcon(page, label)));

    expect(await readRowTexts(page)).toEqual(['unsorted.fake', 'Alpha', 'Beta', 'Shape', 'Corners', 'Edges', 'sides', 'Largest', 'Zeta']);
    expect(await readRowTooltip(page, 'Largest')).toBe('public static Largest');
    expect(icons.map(icon => icon?.match(/<path /g)?.length)).toEqual([1, 1, 2, 2]);
    expect(icons[1]).toBe(icons[0]!);
    expect(icons[2]).toContain('<circle cx="12" cy="12" r="5"/>');
    expect(icons[3]).toContain('<circle cx="13" cy="3" r="3"/>');
    expect(violations).toEqual([]);
}, testTimeoutMs);

// reads the start of a codicon's path, which the icon of a row draws
async function readCodiconPath(codicon: string): Promise<string> {
    const svg = await Bun.file(`node_modules/@vscode/codicons/src/icons/${codicon}.svg`).text();

    return /<path [^>]*d="([^"]{16})/.exec(svg)![1];
}

test("sections come before namespaces with the icons of a folder, a library and a binary file with a private resource's badge", async () => {
    const { page } = await openWorkbench();

    await dropFiles(page, { 'parts.fake': parts });
    await expandRows(page, 'parts.fake', 'References', 'Resources');
    const icons = await Promise.all(['References', 'Shapes', 'palette.txt'].map(label => readRowIcon(page, label)));
    const paths = await Promise.all(['folder', 'library', 'file-binary'].map(readCodiconPath));

    expect(await readRowTexts(page)).toEqual([
        'parts.fake',
        'References',
        'Shapes 1.0.0.0',
        'Resources',
        'palette.txt 24 bytes',
        'Alpha',
        'Zeta',
    ]);
    expect(icons.map((icon, index) => icon?.includes(paths[index]))).toEqual([true, true, true]);
    expect(icons[2]).toContain('<circle cx="12" cy="12" r="5"/>');
}, testTimeoutMs);

test("clicks on a section's rows don't open a document", async () => {
    const { page } = await openWorkbench();

    await dropFiles(page, { 'parts.fake': parts });
    await expandRows(page, 'parts.fake', 'References', 'Resources');
    await findRow(page, 'Shapes').click();
    await findRow(page, 'palette.txt').dblclick();
    // opens Zeta last and waits for its document, because a document that the clicks before it opened would come first
    await findRow(page, 'Zeta').dblclick();
    await waitForEngineReplies(page, 'read');

    const tabs = [aboutTab, { label: 'Zeta.code', isPreview: false }];
    expect(await readUntil(() => readTabs(page), tabs)).toEqual(tabs);
}, testTimeoutMs);

test('Symbols view leaves out a row that the first view hides', async () => {
    const { page } = await openWorkbench();

    await dropFiles(page, { 'box.fake': 'fake\nclass Box\n hidden private field backing\n public method Get\n' });
    await expandRows(page, 'box.fake', 'Box');

    expect(await readRowTexts(page)).toEqual(['box.fake', 'Box', 'Get']);
}, testTimeoutMs);

test("F12 into a document of a collapsed file selects the document's row in the Symbols view, with the focus in the editor", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await dropAndWait(page, { 'shapes.fake': shapes });
    await openCircle(page, drawing, 'Draw');

    await findWord(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area').click();
    await page.keyboard.press('F12');

    expect(await readUntil(() => readActiveTab(page), 'Shape.code')).toBe('Shape.code');
    expect(await readUntil(() => readSelectedRows(page), ['Shape'])).toEqual(['Shape']);
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.monaco-editor')))).toBe(true);
    expect(errors).toEqual([]);
}, testTimeoutMs);

test("a click on a member's row keeps the member's row selected while its class's document opens", async () => {
    const { page } = await openWorkbench();

    await openCircle(page, drawing, 'Draw');
    // waits for a reveal of the class's row, which would come after the document's tab
    await Bun.sleep(1000);

    expect(await readSelectedRows(page)).toEqual(['Draw']);
}, testTimeoutMs);

test("a switch to another document's tab selects that document's row in the Symbols view", async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'shapes.fake': shapes });
    await expandRows(page, 'shapes.fake', 'Shapes');
    await findRow(page, 'Shape').dblclick();
    await dropFiles(page, { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake', 'Drawing', 'Circle');
    await findRow(page, 'Draw').click();
    await waitForTabs(page, 'About', 'Shape.code', 'Circle.code');

    await findTab(page, 'Shape.code').click();

    expect(await readUntil(() => readSelectedRows(page), ['Shape'])).toEqual(['Shape']);
}, testTimeoutMs);

test("file's row shows the listing's note, with each missing file below the row until the missing file opens", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake');
    await findRow(page, 'drawing.fake').locator('.label-description').filter({ hasText: '1 class left out' }).waitFor();
    const before = await readRowTexts(page);
    const missingFileIcon = await findRow(page, 'drawing.notes').locator('.custom-view-tree-node-item-icon').getAttribute('class');

    await dropFiles(page, { 'shapes.fake': shapes });
    await findRows(page).and(page.locator('[aria-level="1"]')).filter({ hasText: 'shapes.fake' }).waitFor();

    expect(before).toEqual(['drawing.fake 1 class left out', 'drawing.notes not loaded', 'shapes.fake not loaded', 'Drawing']);
    expect(missingFileIcon).toContain('codicon-library');
    expect(await readRowTexts(page)).toEqual(['drawing.fake 1 class left out', 'drawing.notes not loaded', 'Drawing', 'shapes.fake']);
}, testTimeoutMs);

test("Open Files passes the extensions of the engines' manifests to the browser's file dialog", async () => {
    const { page } = await openWorkbench();
    // leaves the Java engine out because the dialog takes any file while an engine has magics
    await startWithEngines(page, { fake: null });
    const chooser = page.waitForEvent('filechooser');

    await findOpenFilesButton(page).click();

    expect(await (await chooser).element().getAttribute('accept')).toBe('.fake');
}, testTimeoutMs);

test('Open Folder lists the fake files of the folder and its subfolders', async () => {
    const folder = writeFiles({ 'bin/drawing.fake': drawing, 'bin/lib/shapes.fake': shapes, 'bin/readme.txt': 'A text file.' });
    const { page } = await openWorkbench();

    await chooseFiles(page, 'Open Folder', `${folder}/bin`);
    await findRow(page, 'shapes.fake').waitFor();

    expect(await readRowTexts(page)).toEqual(['drawing.fake', 'shapes.fake']);
}, testTimeoutMs);

test("drop lists a folder's fake files past the first 100 entries and leaves out the files that the engine doesn't claim", async () => {
    const { page } = await openWorkbench();
    const many = Array.from({ length: 120 }, (_, index) => [`bin/many/file${index}.fake`, shapes]);

    await dropFiles(page, {
        ...Object.fromEntries(many),
        'bin/notes.txt': drawing,
        'bin/other.fake': 'A text file.',
        'bin/lib/shapes.fake': shapes,
        'drawing.fake': drawing,
    });
    await findRows(page).and(page.locator('[aria-setsize="122"]')).first().waitFor();

    expect((await readRowTexts(page)).slice(0, 4)).toEqual(['drawing.fake', 'file0.fake', 'file1.fake', 'file2.fake']);
}, testTimeoutMs);

test("drop of a file that no engine opens shows a warning with the file's name", async () => {
    const { page } = await openWorkbench();

    await dropFiles(page, { 'notes.txt': 'A text file.' });

    expect(await readWarnings(page, "No engine opens 'notes.txt'.")).toEqual(["No engine opens 'notes.txt'."]);
}, testTimeoutMs);

test("Open Files with files that no engine opens shows 1 warning with the files' names", async () => {
    const { page } = await openWorkbench();

    await chooseFiles(page, 'Open Files', { 'a.txt': '', 'drawing.fake': drawing, 'b.txt': '' });
    await findRow(page, 'drawing.fake').waitFor();

    expect(await readWarnings(page, "No engine opens 'a.txt' or 'b.txt'.")).toEqual(["No engine opens 'a.txt' or 'b.txt'."]);
}, testTimeoutMs);

test('Open Folder without a file that an engine opens shows a warning', async () => {
    const folder = writeFiles({ 'bin/readme.txt': 'A text file.', 'bin/lib/notes.txt': 'A text file.' });
    const { page } = await openWorkbench();

    await chooseFiles(page, 'Open Folder', `${folder}/bin`);

    expect(await readWarnings(page, 'No file in the folder can be opened.')).toEqual(['No file in the folder can be opened.']);
}, testTimeoutMs);

test('file opened again from the same path replaces the open file', async () => {
    const { page } = await openWorkbench();
    await chooseFiles(page, 'Open Files', { 'drawing.fake': drawing });
    await expandRows(page, 'drawing.fake');

    await chooseFiles(page, 'Open Files', { 'drawing.fake': shapes });
    await findRow(page, 'Shapes').waitFor();

    expect(await readRowTexts(page)).toEqual(['drawing.fake', 'Shapes']);
    await closeLastFile(page, 'drawing.fake');
}, testTimeoutMs);

test('file dropped twice back to back has 1 row and 1 open file in the engine', async () => {
    const { page } = await openWorkbench();

    await dropFiles(page, { 'drawing.fake': drawing });
    await dropFiles(page, { 'drawing.fake': drawing });
    await dropFiles(page, { 'shapes.fake': shapes });
    await findRow(page, 'shapes.fake').waitFor();

    expect(await readRowTexts(page)).toEqual(['drawing.fake', 'shapes.fake']);
    await closeWithMenu(page, 'drawing.fake');
    await closeLastFile(page, 'shapes.fake');
}, testTimeoutMs);

test("Close on a file's row removes the file and keeps the engine's worker for the other file", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'drawing.fake': drawing, 'shapes.fake': shapes });
    await expandRows(page, 'drawing.fake');

    await closeWithMenu(page, 'drawing.fake');

    expect(await readRowTexts(page)).toEqual(['shapes.fake']);
    expect(listEngineWorkers(page)).toEqual(['/engines/fake/worker.js']);
}, testTimeoutMs);

test("engine's worker stops after the Delete key closes the last file", async () => {
    const { page, violations } = await openWorkbench();
    await dropFiles(page, { 'shapes.fake': shapes });

    await closeLastFile(page, 'shapes.fake');
    await findOpenFilesButton(page).waitFor();

    expect(listEngineWorkers(page)).toEqual([]);
    expect(violations).toEqual([]);
}, testTimeoutMs);

test('Cmd+Backspace closes a file on a Mac, like in the explorer of VS Code', async () => {
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
    const { page } = await openWorkbench('dark', { userAgent });
    await dropFiles(page, { 'shapes.fake': shapes, 'drawing.fake': drawing });

    await findRow(page, 'shapes.fake').click();
    await page.keyboard.press('Meta+Backspace');
    await findRow(page, 'shapes.fake').waitFor({ state: 'detached' });

    expect(await readRowTexts(page)).toEqual(['drawing.fake']);
}, testTimeoutMs);

test("Delete key doesn't close a file while a symbol's row or no row is selected", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'shapes.fake': shapes });
    await expandRows(page, 'shapes.fake');

    await findRow(page, 'Shapes').click();
    await page.keyboard.press('Delete');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Delete');
    await dropFiles(page, { 'drawing.fake': drawing });
    await findRow(page, 'drawing.fake').waitFor();

    expect(await readRowTexts(page)).toEqual(['drawing.fake', 'shapes.fake', 'Shapes', 'Shape']);
}, testTimeoutMs);

test("row of a file that the engine can't open shows the engine's error text", async () => {
    const { page } = await openWorkbench();

    await dropFiles(page, { 'broken.fake': 'fake\nnonsense\n' });
    await findRow(page, 'broken.fake').waitFor();

    expect(await readRowTexts(page)).toEqual(["broken.fake The fake engine can't read the line 'nonsense' of broken.fake."]);
    expect(await findRow(page, 'broken.fake').getAttribute('aria-expanded')).toBeNull();
}, testTimeoutMs);

test("drop opens the other files when an engine crashes on a file and shows the crash on that file's row", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, {
        fake: null,
        gone: { extensions: ['.gone'] },
        test: { extensions: ['.test'], serve: serveTestEngine },
    });

    await dropFiles(page, { 'a.fake': shapes, 'crash.test': '', 'missing.gone': '', 'z.fake': shapes });
    await findRow(page, 'z.fake').waitFor();

    expect(await readRowTexts(page)).toEqual(['a.fake', `crash.test ${crashText}`, `missing.gone ${crashText}`, 'z.fake']);
}, testTimeoutMs);

test("file's row shows while a later file of the same drop still opens", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { test: { extensions: ['.test'], serve: serveTestEngine } });

    await dropFiles(page, { 'a.test': '', 'slow.test': '' });
    await findRow(page, 'a.test').waitFor();

    expect(await readRowTexts(page)).toEqual(['a.test']);
}, testTimeoutMs);

test("expand lists a file again after the engine refused the file's first listing", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { test: { extensions: ['.test'], serve: serveTestEngine } });
    await dropFiles(page, { 'flaky.test': '' });
    const twistie = findRow(page, 'flaky.test').locator('.monaco-tl-twistie');

    await twistie.click();
    await findRow(page, 'flaky.test').locator('.label-description').filter({ hasText: "The test engine can't list flaky.test." }).waitFor();
    await twistie.click();
    await expandRows(page, 'flaky.test');

    expect(await readRowTexts(page)).toEqual(['flaky.test', 'Listed']);
}, testTimeoutMs);

test("file opens in the first engine of the site's index that claims the file", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { early: { extensions: ['.fake'], serve: serveTestEngine }, fake: null });

    await dropFiles(page, { 'shapes.fake': shapes });
    await expandRows(page, 'shapes.fake');

    expect(await readRowTexts(page)).toEqual(['shapes.fake', 'Listed']);
}, testTimeoutMs);

test("empty Symbols view shows the error of an engine that didn't load while files open in the other engines", async () => {
    const { page } = await openWorkbench();

    await startWithEngines(page, { broken: null, fake: null });
    const texts = await page.locator('.welcome-view-content p').allTextContents();
    await dropFiles(page, { 'shapes.fake': shapes });
    await findRow(page, 'shapes.fake').waitFor();

    expect(texts.at(-1)).toBe("The site couldn't load the engine 'broken' (the site doesn't have /engines/broken/manifest.json).");
}, testTimeoutMs);

test("policy violation inside an engine's worker reaches the page's violations", async () => {
    const { page, violations } = await openWorkbench();
    await dropFiles(page, { 'shapes.fake': shapes });
    await findRow(page, 'shapes.fake').waitFor();

    const reported = page.waitForEvent('console', message => message.text().includes('Content Security Policy'));

    await page.workers()[0].evaluate(() => fetch('https://example.com/data').catch(() => undefined));
    await reported;

    expect(violations).toEqual(['Content Security Policy violation of connect-src by https://example.com/data']);
}, testTimeoutMs);
