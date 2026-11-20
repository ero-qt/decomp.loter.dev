import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll } from 'bun:test';
import { type Browser, chromium, type Page } from 'playwright';
import { siteHeaders } from './headers';

const siteRoot = new URL('../artifacts/site/', import.meta.url);

export const testTimeoutMs = 30000;

/** Finds the built site's file for a URL's path, with `index.html` for a folder. */
export function findSiteFile(pathname: string, root = siteRoot) {
    return Bun.file(new URL(`.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`, root));
}

/** Serves the built site like a static host on a free port, with the site's headers on every response. */
export function startSiteServer(root = siteRoot) {
    if (!existsSync(new URL('index.html', root))) {
        throw new Error("the site isn't built, run `bun run build` first");
    }

    return Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const file = findSiteFile(new URL(request.url).pathname, root);
            if (!(await file.exists())) {
                return new Response(null, { status: 404, headers: siteHeaders });
            }

            return new Response(file, { headers: siteHeaders });
        },
    });
}

// writes each violation to the console because Chromium's own message for a trusted types violation doesn't have the
// policy's name
function reportViolations() {
    addEventListener('securitypolicyviolation', event => {
        const { violatedDirective, blockedURI } = event as SecurityPolicyViolationEvent;
        console.error(`Content Security Policy violation of ${violatedDirective} by ${blockedURI}`);
    });
}

/**
 * Starts the site server and Chromium before a file's tests and stops both after the last test. Returns the function
 * `openWorkbench`, which opens the site in a new page that closes after the test and waits for the workbench.
 * `openWorkbench` returns the page, the message of each content security policy violation and the URL of each request.
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
        page = await browser!.newPage({ colorScheme });
        // gives each step a third of a test's time because a step that hangs then fails with the step's own message
        page.setDefaultTimeout(testTimeoutMs / 3);
        page.on('request', request => requests.push(request.url()));
        page.on('console', message => {
            if (message.text().includes('Content Security Policy')) {
                violations.push(message.text());
            }
        });
        await page.addInitScript(reportViolations);
        await page.goto(server!.url.href);
        await page.locator('.monaco-workbench .part.statusbar').waitFor();
        await page.waitForLoadState('networkidle');

        return { page, violations, requests };
    };
}
