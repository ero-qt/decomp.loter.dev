import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { siteHeaders } from '../shell/headers';
import { listChecksums } from './checksums';

const longCache = 'public, max-age=31536000, immutable';

interface ExpectedResponse {
    path: string;
    status: number;
    cacheControl: string | null;
    contentType?: string;
}

// lists the responses that Apache sends with host/htaccess for a few files of the built site and for missing files
function listExpectedResponses(siteFolder: string): ExpectedResponse[] {
    const asset = readdirSync(`${siteFolder}/assets`).sort()[0];
    const framework = readdirSync(`${siteFolder}/engines/dotnet/_framework`).sort().find(name => name.endsWith('.wasm'));

    return [
        { path: '/', status: 200, cacheControl: 'no-cache' },
        { path: '/favicon.svg', status: 200, cacheControl: 'no-cache', contentType: 'image/svg+xml' },
        { path: '/checksums.txt', status: 200, cacheControl: 'no-cache' },
        { path: '/missing', status: 404, cacheControl: null },
        { path: '/assets/missing-12345678.js', status: 404, cacheControl: null },
        { path: `/assets/${asset}`, status: 200, cacheControl: longCache },
        { path: `/engines/dotnet/_framework/${framework}`, status: 200, cacheControl: longCache, contentType: 'application/wasm' },
        { path: '/engines/dotnet/_framework/dotnet.js', status: 200, cacheControl: 'no-cache' },
        { path: '/engines/index.json', status: 200, cacheControl: 'no-cache', contentType: 'application/json' },
        { path: '/engines/native/rizin.mjs', status: 200, cacheControl: 'no-cache', contentType: 'text/javascript' },
        { path: '/engines/native/rizin.wasm', status: 200, cacheControl: 'no-cache', contentType: 'application/wasm' },
    ];
}

// lists each way that the response differs from the expected response
function checkResponse(response: Response, { path, status, cacheControl, contentType }: ExpectedResponse): string[] {
    const problems: string[] = [];
    if (response.status !== status) {
        problems.push(`${path} has the status ${response.status}, not ${status}`);
    }

    // finds a header that the host sends twice too, because its value then has both values
    for (const [name, value] of Object.entries({ ...siteHeaders, 'Cache-Control': cacheControl })) {
        const sent = response.headers.get(name);
        if (sent !== value) {
            problems.push(`${path} sends ${name} ${JSON.stringify(sent)}, not ${JSON.stringify(value)}`);
        }
    }

    const sentType = response.headers.get('Content-Type');
    if (contentType && !sentType?.startsWith(contentType)) {
        problems.push(`${path} sends Content-Type ${JSON.stringify(sentType)}, not ${contentType}`);
    }

    return problems;
}

/**
 * Lists each response of the site at the URL that differs from host/htaccess, for a few files of the built site in the
 * folder and for missing files. Also checks that the site's page is the built `index.html`, so a deploy that didn't
 * switch the site shows. Checks too that a missing file gets the built `404.html`, not the host's own page, and that
 * the site's `checksums.txt` lists the built site's files.
 */
export async function checkSiteResponses(siteUrl: URL, siteFolder: string): Promise<string[]> {
    const problems: string[] = [];

    for (const expected of listExpectedResponses(siteFolder)) {
        const response = await fetch(new URL(expected.path, siteUrl), { redirect: 'manual' });
        const page = expected.path === '/' ? 'index.html' : expected.status === 404 ? '404.html' : undefined;
        if (expected.path === '/checksums.txt') {
            if ((await response.text()) !== listChecksums(siteFolder)) {
                problems.push("/checksums.txt isn't the site's checksums");
            }
        } else if (!page) {
            await response.body?.cancel();
        } else if ((await response.text()) !== (await Bun.file(`${siteFolder}/${page}`).text())) {
            problems.push(`${expected.path} isn't the built ${page}`);
        }

        problems.push(...checkResponse(response, expected));
    }

    // accepts a site without the balance because only the host's timer writes it
    const balance = await fetch(new URL('/balance.json', siteUrl), { redirect: 'manual' });
    await balance.body?.cancel();
    const isBalanceFound = balance.status !== 404;
    problems.push(...checkResponse(balance, {
        path: '/balance.json',
        status: isBalanceFound ? 200 : 404,
        cacheControl: isBalanceFound ? 'no-cache' : null,
        contentType: isBalanceFound ? 'application/json' : undefined,
    }));

    const listing = await fetch(new URL('/assets/', siteUrl), { redirect: 'manual' });
    await listing.body?.cancel();
    if (listing.ok) {
        problems.push('/assets/ lists its files');
    }

    return problems;
}

if (import.meta.main) {
    const problems = await checkSiteResponses(new URL(Bun.argv[2]), fileURLToPath(new URL('../artifacts/site', import.meta.url)));
    if (problems.length > 0) {
        console.error(problems.join('\n'));
        process.exit(1);
    }
}
