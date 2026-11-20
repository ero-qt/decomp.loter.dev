import { expect, test } from 'bun:test';
import { fakeManifest } from '../../contract/fake';
import { readManifest } from '../../contract/manifest';
import { findSiteFile, startWorkbench, testTimeoutMs } from '../../shell/page-testing';

const openWorkbench = startWorkbench();

test("site lists the fake engine and has the fake engine's manifest", async () => {
    expect(await findSiteFile('/engines/index.json').json()).toEqual(['fake', 'java']);
    expect(readManifest(await findSiteFile('/engines/fake/manifest.json').json())).toEqual(fakeManifest);
});

test("fake engine's worker gets ready on the site without a policy violation", async () => {
    const { page, violations } = await openWorkbench();

    const message = await page.evaluate(() => {
        // makes the URL a trusted one because the site's policy requires trusted types for a worker's script
        const trusted = window.trustedTypes!.createPolicy('worker.test', { createScriptURL: url => url });
        // casts the trusted URL because TypeScript's `Worker` takes a string or a `URL` only
        const worker = new Worker(trusted.createScriptURL('engines/fake/worker.js') as unknown as URL, { type: 'module' });

        return new Promise(resolve => worker.addEventListener('message', event => resolve(event.data), { once: true }));
    });

    expect(message).toEqual({ ready: true });
    expect(violations).toEqual([]);
}, testTimeoutMs);
