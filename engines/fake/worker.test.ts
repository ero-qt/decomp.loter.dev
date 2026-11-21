import { expect, test } from 'bun:test';
import { fakeManifest } from '../../contract/fake';
import { readManifest } from '../../contract/manifest';
import { findSiteFile, startSiteServer, startWorkbench, testTimeoutMs } from '../../shell/page-testing';

const openWorkbench = startWorkbench();

test('built site leaves out the fake engine because only the tests use it', async () => {
    expect(await findSiteFile('/engines/index.json').json()).toEqual(['dotnet', 'java', 'native']);
    expect(await findSiteFile('/engines/fake/manifest.json').exists()).toBe(false);
});

test("site server for the tests lists the fake engine and serves the fake engine's manifest", async () => {
    const server = startSiteServer();

    try {
        expect(await (await fetch(new URL('engines/index.json', server.url))).json()).toEqual(['dotnet', 'fake', 'java', 'native']);
        expect(readManifest(await (await fetch(new URL('engines/fake/manifest.json', server.url))).json())).toEqual(fakeManifest);
    } finally {
        server.stop();
    }
});

test("fake engine's worker gets ready on the site without a policy violation", async () => {
    const { page, violations } = await openWorkbench();

    const message = await page.evaluate(() => {
        // makes the URL a trusted one because the site's policy requires trusted types for a worker's script
        const trusted = window.trustedTypes!.createPolicy('worker.test', { createScriptURL: url => url });
        // casts the trusted URL because TypeScript's `Worker` only takes a string or a `URL`
        const worker = new Worker(trusted.createScriptURL('engines/fake/worker.js') as unknown as URL, { type: 'module' });

        return new Promise(resolve => worker.addEventListener('message', event => resolve(event.data), { once: true }));
    });

    expect(message).toEqual({ ready: true });
    expect(violations).toEqual([]);
}, testTimeoutMs);
