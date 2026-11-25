import { fakeManifest } from '#contract/fake';
import type { View } from '#contract/manifest';
import type { WorkerRequest } from '#contract/serve';
import { afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Locator, Page } from 'playwright';
import { findOpenFilesButton } from './page-testing';

const testFolder = new URL('../artifacts/test/', import.meta.url).pathname;
const writtenFolders: string[] = [];

afterEach(() => {
    for (const folder of writtenFolders.splice(0)) {
        rmSync(folder, { recursive: true, force: true });
    }
});

/** Finds the Symbols view's rows. */
export function findRows(page: Page): Locator {
    return page.getByRole('tree', { name: 'Symbols' }).getByRole('treeitem');
}

/** Finds the Symbols view's first row with a label. */
export function findRow(page: Page, label: string): Locator {
    return findRows(page).filter({ has: page.locator('.label-name').getByText(label, { exact: true }) }).first();
}

/** Finds the Symbols view's progress strip while the strip runs. */
export function findProgressStrip(page: Page): Locator {
    return page.locator('.pane').filter({ has: findPaneHeader(page, 'Symbols') }).locator('.monaco-progress-container.active');
}

/** Finds the header of the Explorer's view with a title. */
export function findPaneHeader(page: Page, title: string): Locator {
    return page.locator('.pane-header').filter({ has: page.locator('h3.title').getByText(title, { exact: true }) });
}

/**
 * Writes a file for each path and text or bytes into a new folder below `artifacts/test` and returns the folder's path.
 * The folder is removed after the test.
 */
export function writeFiles(files: Record<string, string | Uint8Array>): string {
    mkdirSync(testFolder, { recursive: true });
    const folder = mkdtempSync(`${testFolder}files-`);
    writtenFolders.push(folder);
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(`${folder}/${path}`), { recursive: true });
        writeFileSync(`${folder}/${path}`, text);
    }

    return folder;
}

/**
 * Drops a file for each path and text or bytes on the workbench, like files and folders dragged in from the desktop. A
 * path with a folder, like `bin/drawing.fake`, drops the folder.
 */
export async function dropFiles(page: Page, files: Record<string, string | Uint8Array>) {
    const folder = writeFiles(files);
    const dropped = new Set(Object.keys(files).map(path => `${folder}/${path.split('/')[0]}`));
    const data = { items: [], files: [...dropped], dragOperationsMask: 1 };
    // drops through the DevTools protocol because a page's script can't make a real folder's entry
    const session = await page.context().newCDPSession(page);
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await session.send('Input.dispatchDragEvent', { type, x: 300, y: 300, data });
    }

    await session.detach();
}

/**
 * Drops a file for each path and text or bytes like `dropFiles` and waits for each file's row at the top of the Symbols
 * view.
 */
export async function dropAndWait(page: Page, files: Record<string, string | Uint8Array>) {
    await dropFiles(page, files);
    for (const path of Object.keys(files)) {
        await findRows(page).and(page.locator('[aria-level="1"]')).filter({ hasText: path.split('/').at(-1) }).waitFor();
    }
}

/**
 * Serves an engine for tests in a worker. The engine claims each file, lists the class `Listed`, which has its own
 * document, for a file and doesn't list any strings. The engine crashes on `open` of a file whose name starts with
 * `crash`, doesn't reply to `open` of a file whose name starts with `slow`, replies to `open` of a file whose name
 * starts with `delayed` after 1 second, refuses the first `list` of a file whose name starts with `flaky` and every
 * `list` of a file whose name starts with `unlisted`. The first
 * line of `Listed`'s document has the file's name and the number of the engine's `read` calls. The engine refuses the
 * first `read` of a file whose name starts with `refusing`, replies to `read` of a file whose name starts with `late`
 * after 1 second and doesn't reply to a `read` after the engine's first `read` of a file whose name starts with
 * `stuck`.
 */
export function serveTestEngine() {
    // file's id -> the file's name
    const names = new Map<unknown, string>();
    let hasRefused = false;
    let hasRefusedRead = false;
    let readCount = 0;

    function read(fileId: unknown, name: string) {
        const head = `${name} read ${++readCount}\nclass `;
        // the token `Listed` with the kind `class` and the modifier `declaration`
        const tokens = new Int32Array([head.length, 6, 1, 16, 0]);
        const reply = { value: { text: `${head}Listed\n`, tokens, targets: [`${fileId}:1`], locals: [] } };
        if (name.startsWith('stuck') && readCount > 1) {
            return;
        }
        if (name.startsWith('refusing') && !hasRefusedRead) {
            hasRefusedRead = true;
            postMessage({ reply: { error: `The test engine can't write Listed's document in read ${readCount}.` } });
        } else {
            setTimeout(() => postMessage({ reply }), name.startsWith('late') ? 1000 : 0);
        }
    }

    onmessage = function ({ data }: MessageEvent<WorkerRequest>) {
        // ignores a cancel message because the engine finishes each call
        if ('cancel' in data) {
            return;
        }

        const { method, args } = data;
        const name = method === 'open' ? String(args[1]) : names.get(args[0]) ?? '';
        // the class `Listed` with the modifier `document`
        const listing = { values: new Int32Array([1, 32, -1, 1, 0]), names: ['Listed'], details: [''], note: '', missingFiles: [] };
        names.set(args[0], name);
        if (method === 'open' && name.startsWith('crash')) {
            postMessage({ fatal: 'the test engine crashed' });
        } else if (method === 'list' && name.startsWith('unlisted')) {
            postMessage({ reply: { error: `The test engine can't list ${name}.` } });
        } else if (method === 'list' && name.startsWith('flaky') && !hasRefused) {
            hasRefused = true;
            postMessage({ reply: { error: `The test engine can't list ${name}.` } });
        } else if (method === 'read') {
            read(args[0], name);
        } else if (method === 'open' && name.startsWith('delayed')) {
            setTimeout(() => postMessage({ reply: { value: undefined } }), 1000);
        } else if (method !== 'open' || !name.startsWith('slow')) {
            // method -> the method's value
            const values: Record<string, unknown> = { claims: true, list: listing, listStrings: [] };
            postMessage({ reply: { value: values[method] } });
        }
    };

    postMessage({ ready: true });
}

/** The engine of `serveTestEngine` for `startWithEngines`, with the extension `.test`. */
export const testEngine = { extensions: ['.test'], serve: serveTestEngine };

/** An engine for `startWithEngines`. */
export interface RoutedEngine {
    extensions: string[];
    magics?: string[];
    /** The manifest's views. The manifest gets the fake engine's views when the engine doesn't give any. */
    views?: View[];
    serve?: () => void;
}

/**
 * Starts the workbench again with other engines in the site's index, in the ids' order. An id with an engine gets a
 * manifest and, with `serve`, a worker that runs `serve`. An id with `null` is left to the site.
 */
export async function startWithEngines(page: Page, engines: Record<string, RoutedEngine | null>) {
    await page.route('**/engines/index.json', route => route.fulfill({ json: Object.keys(engines) }));
    for (const [id, engine] of Object.entries(engines)) {
        if (engine) {
            const { extensions, magics, views = fakeManifest.views } = engine;
            const manifest = { ...fakeManifest, id, name: id, extensions, magics, views };
            await page.route(`**/engines/${id}/manifest.json`, route => route.fulfill({ json: manifest }));
        }
        if (engine?.serve) {
            const body = `(${engine.serve})();`;
            await page.route(`**/engines/${id}/worker.js`, route => route.fulfill({ contentType: 'text/javascript', body }));
        }
    }

    await page.reload();
    await findOpenFilesButton(page).waitFor();
}

/**
 * Expands the rows with the labels in their order, each row below the row before it, and waits for the first row below
 * each row.
 */
export async function expandRows(page: Page, ...labels: string[]) {
    for (const label of labels) {
        const row = findRow(page, label);
        if ((await row.getAttribute('aria-expanded')) !== 'true') {
            await row.locator('.monaco-tl-twistie').click();
        }

        // finds the row again on each try because the tree draws a row again in a new element when the row's file
        // changes
        await page.waitForFunction(label => {
            const rows = [...document.querySelectorAll<HTMLElement>('[role=tree][aria-label=Symbols] [role=treeitem]')];
            const row = rows.find(row => row.querySelector('.label-name')?.textContent === label && row.ariaExpanded === 'true');
            const below = rows.find(below => Number(below.dataset.index) === Number(row?.dataset.index) + 1);

            return Number(below?.ariaLevel) > Number(row?.ariaLevel);
        }, label);
    }
}

/** Reads each row's label and description in the rows' order in the Symbols view. */
export function readRowTexts(page: Page): Promise<string[]> {
    return findRows(page).evaluateAll(rows => {
        // sorts by the rows' index because the tree keeps the rows in another order in the page
        const sorted = (rows as HTMLElement[]).sort((first, second) => Number(first.dataset.index) - Number(second.dataset.index));

        return sorted.map(row => {
            const description = row.querySelector('.label-description')?.textContent ?? '';

            return `${row.querySelector('.label-name')!.textContent} ${description}`.trim();
        });
    });
}

/** Reads the SVG of a row's icon from the data URL that the row shows. */
export async function readRowIcon(page: Page, label: string): Promise<string | undefined> {
    const image = await findRow(page, label).locator('.custom-view-tree-node-item-icon').evaluate(icon => icon.style.backgroundImage);
    const [, data] = /data:image\/svg\+xml;base64,([\w+/=]+)/.exec(image) ?? [];

    return data && atob(data);
}

/** Reads the tooltip that the Symbols view shows while the pointer is on a row. */
export async function readRowTooltip(page: Page, label: string): Promise<string | null> {
    await findRow(page, label).hover();
    const hover = page.locator('.monaco-hover-content').filter({ hasText: label });
    await hover.waitFor();
    const text = await hover.textContent();
    await page.mouse.move(0, 0);
    await hover.waitFor({ state: 'detached' });

    return text;
}
