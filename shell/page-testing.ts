import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BuildArtifact } from 'bun';
import { afterAll, afterEach, beforeAll } from 'bun:test';
import { type Browser, chromium, type Locator, type Page } from 'playwright';
import { siteHeaders } from './headers';

const siteRoot = new URL('../artifacts/site/', import.meta.url);
const fakeEngine = new URL('../engines/fake/', import.meta.url);
let fakeWorker: Promise<BuildArtifact> | undefined;

export const testTimeoutMs = 30000;

/** Finds the built site's file for a URL's path, with `index.html` for a folder. */
export function findSiteFile(pathname: string, root = siteRoot) {
    return Bun.file(new URL(`.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`, root));
}

// builds the fake engine's worker like `engines/build.ts` builds an engine's worker, because the site leaves the fake
// engine out
async function buildFakeWorker(): Promise<BuildArtifact> {
    const { outputs } = await Bun.build({
        entrypoints: [fileURLToPath(new URL('worker.ts', fakeEngine))],
        target: 'browser',
        format: 'esm',
        minify: true,
        throw: true,
    });

    return outputs[0];
}

// finds the fake engine's file for a URL's path, or the site's index with the fake engine's id
async function findFakeEngineFile(pathname: string, root: URL): Promise<Blob | undefined> {
    if (pathname === '/engines/index.json') {
        const ids: string[] = await findSiteFile(pathname, root).json();

        return new Blob([JSON.stringify([...ids, 'fake'].sort())], { type: 'application/json' });
    }
    if (pathname === '/engines/fake/manifest.json') {
        return Bun.file(new URL('manifest.json', fakeEngine));
    }
    if (pathname === '/engines/fake/worker.js') {
        fakeWorker ??= buildFakeWorker();

        return fakeWorker;
    }
}

/**
 * Serves the built site like a static host on a free port, with the site's headers on every response and the site's
 * page for a missing file. Adds the fake engine, which only the tests use, to the site's engines.
 */
export function startSiteServer(root = siteRoot) {
    if (!existsSync(new URL('index.html', root))) {
        throw new Error("the site isn't built, run `bun run build` first");
    }

    return Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const { pathname } = new URL(request.url);
            const fakeEngineFile = await findFakeEngineFile(pathname, root);
            if (fakeEngineFile) {
                return new Response(fakeEngineFile, { headers: siteHeaders });
            }

            const file = findSiteFile(pathname, root);
            if (!(await file.exists())) {
                return new Response(findSiteFile('/404.html', root), { status: 404, headers: siteHeaders });
            }

            return new Response(file, { headers: siteHeaders });
        },
    });
}

/** Finds the empty Symbols view's button that opens files. */
export function findOpenFilesButton(page: Page): Locator {
    return page.getByRole('button', { name: 'Open Files', exact: true });
}

/**
 * Runs the command with the title from the command palette. Clicks the row whose label is the title because the palette
 * can rank another command first, like View: Split Editor into Right Group for View: Split Editor Right.
 */
export async function runCommand(page: Page, title: string) {
    await page.keyboard.press('F1');
    await page.keyboard.insertText(title);
    await page.locator('.quick-input-list .monaco-list-row .label-name').getByText(title, { exact: true }).click();
}

/** Lists the URLs of the requests that went to another host than the page's host. */
export function listOtherHostRequests(page: Page, requests: string[]): string[] {
    return requests.filter(url => new URL(url).host !== new URL(page.url()).host);
}

/**
 * Reads the text of the user's file at the path, like `/User/keybindings.json`, from the IndexedDB database that backs
 * the user's data. Returns `undefined` for a file that the workbench didn't store yet.
 */
export function readStoredUserFile(page: Page, path: string): Promise<string | undefined> {
    return page.evaluate(async path => {
        const { promise: opened, resolve, reject } = Promise.withResolvers<IDBDatabase>();
        const request = indexedDB.open('vscode-web-db');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        const database = await opened;

        const file = database.transaction('vscode-userdata-store').objectStore('vscode-userdata-store').get(path);
        const content = await new Promise<Uint8Array | undefined>((resolve, reject) => {
            file.onsuccess = () => resolve(file.result);
            file.onerror = () => reject(file.error);
        });
        database.close();

        return content && new TextDecoder().decode(content);
    }, path);
}

/**
 * Collects the text of each console error and each uncaught error in the page. Leaves out the browser's own message for
 * a missing `balance.json`, because only the host writes the file into the site.
 */
export function collectErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', message => {
        if (message.type() === 'error' && !message.location().url.endsWith('/balance.json')) {
            errors.push(message.text());
        }
    });
    page.on('pageerror', error => errors.push(error.message));

    return errors;
}

// writes each violation to the console because Chromium's own message for a trusted types violation doesn't have the
// policy's name
function reportViolations() {
    addEventListener('securitypolicyviolation', event => {
        const { violatedDirective, blockedURI } = event as SecurityPolicyViolationEvent;
        console.error(`Content Security Policy violation of ${violatedDirective} by ${blockedURI}`);
    });
}

interface EngineCalls {
    /** The method of each call that the page sent to an engine's worker, in the calls' order. */
    methods: string[];
    replyCount: number;
    cancelCount: number;
}

// counts the calls to the engines' workers and their replies because a test waits for a late reply before it checks
// that the reply didn't change the page
function countEngineCalls() {
    const calls: EngineCalls = { methods: [], replyCount: 0, cancelCount: 0 };
    Object.assign(window, { engineCalls: calls });
    window.Worker = class extends Worker {
        private readonly isEngine: boolean;

        constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.isEngine = String(url).includes('/engines/');
            this.addEventListener('message', ({ data }: MessageEvent<object>) => {
                if (this.isEngine && ('reply' in data || 'fatal' in data)) {
                    calls.replyCount++;
                }
            });
        }

        override postMessage(message: object, transfer: Transferable[] | StructuredSerializeOptions = []) {
            // counts a cancel message apart from the calls because the worker doesn't reply to it
            if (this.isEngine && 'method' in message) {
                calls.methods.push(String(message.method));
            } else if (this.isEngine && 'cancel' in message) {
                calls.cancelCount++;
            }

            super.postMessage(message, Array.isArray(transfer) ? { transfer } : transfer);
        }
    };
}

/** Counts the cancel messages that the page sent to the engines' workers, also to a worker that stopped since. */
export function countEngineCancels(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as { engineCalls: EngineCalls }).engineCalls.cancelCount);
}

/** Waits until the page sent the count of calls with the method to the engines' workers. */
export async function waitForEngineCalls(page: Page, method: string, count = 1) {
    await page.waitForFunction(({ method, count }) => {
        const { methods } = (window as unknown as { engineCalls: EngineCalls }).engineCalls;

        return methods.filter(sent => sent === method).length >= count;
    }, { method, count });
}

/**
 * Waits until the page sent the count of calls with the method to the engines' workers and each call that the page sent
 * got its reply. The page handles a reply in the reply's task, before the wait reads the count again.
 */
export async function waitForEngineReplies(page: Page, method: string, count = 1) {
    await waitForEngineCalls(page, method, count);
    await page.waitForFunction(() => {
        const { methods, replyCount } = (window as unknown as { engineCalls: EngineCalls }).engineCalls;

        return replyCount === methods.length;
    });
}

/**
 * Starts the site server and Chromium before a file's tests and stops both after the last test. Returns the function
 * `openWorkbench`, which opens the site in a new page that closes after the test and waits for the Symbols view's
 * buttons. `openWorkbench` returns the page, the message of each content security policy violation in the page and in
 * the engines' workers, and the URL of each request.
 */
export function startWorkbench() {
    let server: ReturnType<typeof startSiteServer> | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;

    beforeAll(async () => {
        server = startSiteServer();
        // launches the full Chromium because Playwright's default is the headless shell, which isn't the browser that
        // people use
        browser = await chromium.launch({ channel: 'chromium' });
    });

    afterEach(() => page?.close());

    afterAll(async () => {
        await browser?.close();
        server?.stop();
    });

    return async function openWorkbench(colorScheme: 'dark' | 'light' = 'dark') {
        const violations: string[] = [];
        const requests: string[] = [];
        // gives the page a screen taller than the window because the workbench takes a window with the screen's height
        // as full screen
        page = await browser!.newPage({ colorScheme, screen: { width: 1920, height: 1080 } });
        // gives each step a third of a test's time because a step that hangs then fails with the step's own message
        page.setDefaultTimeout(testTimeoutMs / 3);
        page.on('request', request => requests.push(request.url()));
        page.on('console', message => {
            if (message.text().includes('Content Security Policy')) {
                violations.push(message.text());
            }
        });
        await page.addInitScript(reportViolations);
        await page.addInitScript(countEngineCalls);
        // adds the listener to each engine's worker script because an init script doesn't run in a worker
        await page.route('**/engines/*/worker.js', async route => {
            const response = await route.fetch();
            await route.fulfill({ response, body: `(${reportViolations})();\n${await response.text()}` });
        });
        await page.goto(server!.url.href);
        await findOpenFilesButton(page).waitFor();
        await page.waitForLoadState('networkidle');

        return { page, violations, requests };
    };
}
