import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { type Browser, chromium, type Page } from 'playwright';
import { findSiteFile, listOtherHostRequests, startSiteServer, testTimeoutMs } from './page-testing';

// a missing path deep in a folder, where a relative link of the page would point into the missing folder
const missingPath = '/assets/missing/missing-12345678.js';

let server: ReturnType<typeof startSiteServer> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;

beforeAll(async () => {
    server = startSiteServer();
    browser = await chromium.launch({ channel: 'chromium' });
});

afterEach(() => page?.close());

afterAll(async () => {
    await browser?.close();
    server?.stop();
});

// opens the missing path and returns the page, the document's status, the text of each error and policy violation
// besides the document's own 404, and the URL and status of each request
async function openMissingPath() {
    const responses: [string, number][] = [];
    const errors: string[] = [];
    page = await browser!.newPage();
    page.setDefaultTimeout(testTimeoutMs / 3);
    const url = new URL(missingPath, server!.url).href;
    page.on('console', message => {
        if (message.type() === 'error' && message.location().url !== url) {
            errors.push(message.text());
        }
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => responses.push([response.url(), response.status()]));
    await page.addInitScript(() => {
        addEventListener('securitypolicyviolation', event => {
            console.error(`Content Security Policy violation of ${(event as SecurityPolicyViolationEvent).violatedDirective}`);
        });
    });
    const document = await page.goto(url);
    await page.waitForLoadState('networkidle');

    return { page, status: document?.status(), errors, responses };
}

test('built site has the page for a missing file', async () => {
    expect(await findSiteFile('/404.html').exists()).toBe(true);
});

test('missing path shows the page for a missing file with the status 404', async () => {
    const { page, status } = await openMissingPath();

    expect(status).toBe(404);
    expect(await page.locator('h1, p').allInnerTexts()).toEqual(['Page not found', "This page doesn't exist.", 'Go to decomp.loter.dev']);
    expect(await page.title()).toBe('Page not found · decomp.loter.dev');
}, testTimeoutMs);

test('page for a missing file links to the start page', async () => {
    const { page } = await openMissingPath();
    const links = page.getByRole('link');

    expect(await links.count()).toBe(1);
    expect(await links.evaluate(link => (link as HTMLAnchorElement).href)).toBe(new URL('/', server!.url).href);
}, testTimeoutMs);

test('page for a missing file deep in a folder loads its style without an error, a policy violation or a request to another host', async () => {
    const { page, errors, responses } = await openMissingPath();
    const files = responses.filter(([url]) => new URL(url).pathname !== missingPath);

    expect(errors).toEqual([]);
    expect(listOtherHostRequests(page, responses.map(([url]) => url))).toEqual([]);
    expect(files.some(([url]) => /^\/assets\/privacy-[\w-]+\.css$/.test(new URL(url).pathname))).toBe(true);
    expect(files.filter(([, status]) => status !== 200)).toEqual([]);
}, testTimeoutMs);

test("sitemap doesn't list the page for a missing file", async () => {
    expect(await findSiteFile('/sitemap.xml').text()).not.toContain('404');
});
