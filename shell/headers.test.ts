import { afterAll, beforeAll, expect, test } from 'bun:test';
import { siteHeaders } from './headers';
import { startSiteServer } from './page-testing';

const policySources = siteHeaders['Content-Security-Policy'].split('; ').flatMap(directive => {
    const [name, ...sources] = directive.split(' ');

    return sources.map(source => `${name} ${source}`);
});

let server: ReturnType<typeof startSiteServer> | undefined;

beforeAll(() => {
    server = startSiteServer();
});

afterAll(() => server?.stop());

test('content security policy allows nothing by default, no base URL, no form target and no frame around the page', () => {
    for (const directive of ['default-src', 'base-uri', 'form-action', 'frame-ancestors']) {
        expect(policySources).toContain(`${directive} 'none'`);
    }
});

test("content security policy allows the site's own files only as scripts, styles, fonts, images, connections and worker scripts", () => {
    expect(policySources.filter(source => source.endsWith(" 'self'"))).toEqual([
        "script-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self'",
        "connect-src 'self'",
        "worker-src 'self'",
    ]);
});

test("content security policy allows only wasm, inline styles and data images besides the site's own files and requires trusted types", () => {
    expect(policySources.filter(source => !/ '(self|none)'$/.test(source))).toEqual([
        "script-src 'wasm-unsafe-eval'",
        "style-src 'unsafe-inline'",
        'img-src data:',
        "require-trusted-types-for 'script'",
    ]);
});

test('site headers keep the referrer from other sites and the content type from a guess', () => {
    expect(siteHeaders).toMatchObject({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
});

test('site server sends the site headers with a file and with a missing file', async () => {
    const names = Object.keys(siteHeaders);

    for (const path of ['/', '/missing']) {
        const { headers } = await fetch(new URL(path, server!.url));

        expect(Object.fromEntries(names.map(name => [name, headers.get(name)]))).toEqual(siteHeaders);
    }
});

test("site server doesn't start without a built site", () => {
    expect(() => startSiteServer(new URL('missing/', import.meta.url))).toThrow("the site isn't built, run `bun run build` first");
});
