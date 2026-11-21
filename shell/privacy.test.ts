import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { type Browser, chromium, type Page } from 'playwright';
import { collectErrors, findSiteFile, listOtherHostRequests, startSiteServer, testTimeoutMs } from './page-testing';

const noticeLines = [
    'Privacy',
    "This website doesn't use any cookies.",
    'All files you provide are read in the browser and are never uploaded.',
    'Access and error logs are turned off on the host (Uberspace).',
];

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

// opens the privacy page and returns the page, the text of each error and policy violation and the URL of each request
async function openPrivacyPage() {
    const requests: string[] = [];
    page = await browser!.newPage();
    page.setDefaultTimeout(testTimeoutMs / 3);
    const errors = collectErrors(page);
    page.on('request', request => requests.push(request.url()));
    await page.addInitScript(() => {
        addEventListener('securitypolicyviolation', event => {
            console.error(`Content Security Policy violation of ${(event as SecurityPolicyViolationEvent).violatedDirective}`);
        });
    });
    await page.goto(new URL('privacy.html', server!.url).href);
    await page.waitForLoadState('networkidle');

    return { page, errors, requests };
}

test('built site has the privacy page', async () => {
    expect(await findSiteFile('/privacy.html').exists()).toBe(true);
});

test('privacy page says what stays in the browser and what the server keeps', async () => {
    const { page } = await openPrivacyPage();

    expect(await page.locator('h1, li').allInnerTexts()).toEqual(noticeLines);
    expect(await page.title()).toBe('Privacy · decomp.loter.dev');
}, testTimeoutMs);

test("privacy page doesn't link anywhere", async () => {
    const { page } = await openPrivacyPage();

    expect(await page.getByRole('link').count()).toBe(0);
}, testTimeoutMs);

test('privacy page loads its style without an error, a policy violation or a request to another host', async () => {
    const { page, errors, requests } = await openPrivacyPage();

    expect(errors).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
    expect(requests.some(url => /\/assets\/privacy-[\w-]+\.css$/.test(url))).toBe(true);
}, testTimeoutMs);

test("privacy page doesn't store anything in the browser", async () => {
    const { page } = await openPrivacyPage();

    const kept = await page.evaluate(async () => ({
        localStorage: localStorage.length,
        sessionStorage: sessionStorage.length,
        databases: await indexedDB.databases(),
    }));

    expect(kept).toEqual({ localStorage: 0, sessionStorage: 0, databases: [] });
    expect(await page.context().cookies()).toEqual([]);
}, testTimeoutMs);

test('sitemap lists the privacy page', async () => {
    expect(await findSiteFile('/sitemap.xml').text()).toContain('<url><loc>https://decomp.loter.dev/privacy.html</loc></url>');
});
