import { afterEach, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { readLongCachePatterns } from '../host/htaccess-testing';
import { siteHeaders } from '../shell/headers';
import { findSiteFile } from '../shell/page-testing';
import { checkSiteResponses } from './check-live';
import { listChecksums } from './checksums';

const siteFolder = fileURLToPath(new URL('../artifacts/site', import.meta.url));
const longCachePatterns = await readLongCachePatterns();

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => server?.stop());

/**
 * Serves the built site like Apache with host/htaccess, with the built site's checksums and each path and text of
 * `files` as a file of the site, or as a missing file for `undefined`, after `change` changed each response's status
 * and headers. Sends `notFoundPage` for a missing file and with the status 403 for `/assets/`, a folder without an index.
 */
function serveLikeHtaccess(
    change: (path: string, status: number, headers: Headers) => number = (path, status) => status,
    files: Record<string, string | undefined> = {},
    notFoundPage: string | Blob = findSiteFile('/404.html', new URL(`file://${siteFolder}/`)),
) {
    const served: Record<string, string | undefined> = { '/checksums.txt': listChecksums(siteFolder), ...files };
    server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const { pathname } = new URL(request.url);
            const file = pathname in served ? served[pathname] : findSiteFile(pathname, new URL(`file://${siteFolder}/`));
            if (file === undefined) {
                const headers = new Headers(siteHeaders);

                return new Response(notFoundPage, { status: change(pathname, 404, headers), headers });
            }

            const isFound = typeof file === 'string' || (!pathname.endsWith('/assets/') && (await file.exists()));
            const headers = new Headers(siteHeaders);
            if (isFound) {
                const isKeptLong = longCachePatterns.some(pattern => pattern.test(pathname));
                headers.set('Cache-Control', isKeptLong ? 'public, max-age=31536000, immutable' : 'no-cache');
            }
            if (typeof file === 'string' && pathname.endsWith('.json')) {
                headers.set('Content-Type', 'application/json');
            }

            const status = change(pathname, isFound ? 200 : pathname.endsWith('/assets/') ? 403 : 404, headers);

            return new Response(isFound ? file : notFoundPage, { status, headers });
        },
    });

    return server.url;
}

test('live check passes a host that answers like host/htaccess', async () => {
    expect(await checkSiteResponses(serveLikeHtaccess(), siteFolder)).toEqual([]);
});

test("live check finds a missing checksums file and checksums that don't match the built site", async () => {
    const missing = serveLikeHtaccess(undefined, { '/checksums.txt': undefined });

    expect(await checkSiteResponses(missing, siteFolder)).toEqual([
        "/checksums.txt isn't the site's checksums",
        '/checksums.txt has the status 404, not 200',
        '/checksums.txt sends Cache-Control null, not "no-cache"',
    ]);

    const changed = serveLikeHtaccess(undefined, { '/checksums.txt': `${'0'.repeat(64)}  index.html\n` });

    expect(await checkSiteResponses(changed, siteFolder)).toEqual(["/checksums.txt isn't the site's checksums"]);
});

test("live check finds a missing file without the site's headers", async () => {
    const url = serveLikeHtaccess((path, status, headers) => {
        if (status === 404) {
            headers.delete('Content-Security-Policy');
        }

        return status;
    });

    expect(await checkSiteResponses(url, siteFolder)).toEqual([
        `/missing sends Content-Security-Policy null, not ${JSON.stringify(siteHeaders['Content-Security-Policy'])}`,
        `/assets/missing-12345678.js sends Content-Security-Policy null, not ${JSON.stringify(siteHeaders['Content-Security-Policy'])}`,
        `/balance.json sends Content-Security-Policy null, not ${JSON.stringify(siteHeaders['Content-Security-Policy'])}`,
    ]);
});

test("live check finds a missing file without the site's page for it, like Apache's own page", async () => {
    const url = serveLikeHtaccess(undefined, undefined, '<h1>Object not found!</h1>');

    expect(await checkSiteResponses(url, siteFolder)).toEqual([
        "/missing isn't the built 404.html",
        "/assets/missing-12345678.js isn't the built 404.html",
        "/assets/ isn't the built 404.html",
    ]);
});

test('live check finds a header that the host sends twice', async () => {
    const url = serveLikeHtaccess((path, status, headers) => {
        if (path === '/') {
            headers.append('Referrer-Policy', 'no-referrer');
        }

        return status;
    });

    expect(await checkSiteResponses(url, siteFolder)).toEqual(['/ sends Referrer-Policy "no-referrer, no-referrer", not "no-referrer"']);
});

test('live check finds a cached missing file and a fingerprinted file that browsers ask for again', async () => {
    const url = serveLikeHtaccess((path, status, headers) => {
        headers.set('Cache-Control', 'no-cache');

        return status;
    });

    expect(await checkSiteResponses(url, siteFolder)).toEqual([
        '/missing sends Cache-Control "no-cache", not null',
        '/assets/missing-12345678.js sends Cache-Control "no-cache", not null',
        '/assets/ sends Cache-Control "no-cache", not null',
        expect.stringMatching(/^\/assets\/.+ sends Cache-Control "no-cache", not "public, max-age=31536000, immutable"$/),
        expect.stringMatching(/^\/engines\/dotnet\/_framework\/.+ sends Cache-Control "no-cache", not "public, max-age=31536000, immutable"$/),
        '/balance.json sends Cache-Control "no-cache", not null',
    ]);
});

test('live check finds wasm without its type, a wrong status and a folder listing', async () => {
    const url = serveLikeHtaccess((path, status, headers) => {
        if (path.endsWith('.wasm')) {
            headers.set('Content-Type', 'application/octet-stream');
        }

        return path === '/assets/' || path === '/missing' ? 200 : status;
    });

    expect(await checkSiteResponses(url, siteFolder)).toEqual([
        '/missing has the status 200, not 404',
        '/assets/ has the status 200, not 403',
        expect.stringMatching(/^\/engines\/dotnet\/_framework\/.+\.wasm sends Content-Type "application\/octet-stream", not application\/wasm$/),
        '/engines/native/rizin.wasm sends Content-Type "application/octet-stream", not application/wasm',
    ]);
});

test("live check finds a folder without an index whose answer lacks the site's headers, like Apache's own 403 page", async () => {
    const url = serveLikeHtaccess((path, status, headers) => {
        if (status === 403) {
            headers.delete('Content-Security-Policy');
        }

        return status;
    });

    expect(await checkSiteResponses(url, siteFolder)).toEqual([
        `/assets/ sends Content-Security-Policy null, not ${JSON.stringify(siteHeaders['Content-Security-Policy'])}`,
    ]);
});

test("live check accepts a host with the balance and a host without it, which only the host's timer writes", async () => {
    const balance = '{"balance":"12.50","price":"9.00","asOf":"2026-11-21T04:17+00:00"}';

    expect(await checkSiteResponses(serveLikeHtaccess(undefined, { '/balance.json': balance }), siteFolder)).toEqual([]);
    expect(await checkSiteResponses(serveLikeHtaccess(), siteFolder)).toEqual([]);
});

test('live check finds a JSON file without its type', async () => {
    const url = serveLikeHtaccess((path, status, headers) => {
        if (path.endsWith('.json')) {
            headers.set('Content-Type', 'text/plain');
        }

        return status;
    });

    expect(await checkSiteResponses(url, siteFolder)).toEqual([
        '/engines/index.json sends Content-Type "text/plain", not application/json',
    ]);
});

test('live check finds a missing favicon and a favicon without its type', async () => {
    const missing = serveLikeHtaccess((path, status) => (path === '/favicon.svg' ? 404 : status));

    expect(await checkSiteResponses(missing, siteFolder)).toEqual(['/favicon.svg has the status 404, not 200']);

    const untyped = serveLikeHtaccess((path, status, headers) => {
        if (path === '/favicon.svg') {
            headers.set('Content-Type', 'text/plain');
        }

        return status;
    });

    expect(await checkSiteResponses(untyped, siteFolder)).toEqual(['/favicon.svg sends Content-Type "text/plain", not image/svg+xml']);
});

test("live check finds a page that isn't the built index.html, like a page of an older release", async () => {
    const url = serveLikeHtaccess(undefined, { '/': '<!doctype html>' });

    expect(await checkSiteResponses(url, siteFolder)).toEqual(["/ isn't the built index.html"]);
});
