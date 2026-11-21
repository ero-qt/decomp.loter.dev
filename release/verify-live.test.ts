import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listChecksums } from './checksums';
import { verifyLiveFiles } from './verify-live';

let site: string;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
    site = mkdtempSync(join(tmpdir(), 'verify-live-'));
    mkdirSync(join(site, 'assets'));
    writeFileSync(join(site, 'index.html'), 'page');
    writeFileSync(join(site, 'assets/main.js'), 'script');
    writeFileSync(join(site, 'checksums.txt'), listChecksums(site));
});

afterEach(() => {
    server?.stop();
    rmSync(site, { recursive: true, force: true });
});

// serves the site's files like the host, which refuses `.htaccess`, with each path and text of `changed` instead
function serveSite(changed: Record<string, string> = {}) {
    server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
            const { pathname } = new URL(request.url);
            const file = Bun.file(join(site, pathname));
            if (pathname === '/.htaccess') {
                return new Response('', { status: 403 });
            }

            return changed[pathname] !== undefined ? new Response(changed[pathname])
                : (await file.exists()) ? new Response(file) : new Response('', { status: 404 });
        },
    });

    return server.url;
}

test('live files match the checksums, which leave out the .htaccess that the host refuses to send', async () => {
    expect(await verifyLiveFiles(serveSite())).toEqual({ checkedCount: 2, problems: [] });
});

test('verification finds a changed file and a missing file', async () => {
    rmSync(join(site, 'index.html'));

    expect(await verifyLiveFiles(serveSite({ '/assets/main.js': 'changed' }))).toEqual({
        checkedCount: 2,
        problems: ["assets/main.js doesn't match its checksum", 'index.html has the status 404'],
    });
});

test("verification refuses a site that doesn't serve its checksums", async () => {
    rmSync(join(site, 'checksums.txt'));

    await expect(verifyLiveFiles(serveSite())).rejects.toThrow('checksums.txt has the status 404');
});

test("verification with a trusted list finds a file that the host changed along with the host's checksums", async () => {
    const trusted = listChecksums(site);
    writeFileSync(join(site, 'index.html'), 'changed');
    writeFileSync(join(site, 'checksums.txt'), listChecksums(site));

    expect(await verifyLiveFiles(serveSite(), trusted)).toEqual({ checkedCount: 2, problems: ["index.html doesn't match its checksum"] });
});
