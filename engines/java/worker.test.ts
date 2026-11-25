import { readdirSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';
import { expect, test } from 'bun:test';
import { readManifest } from '#contract/manifest';
import { findSiteFile, startWorkbench, testTimeoutMs } from '../../shell/page-testing';
import manifest from './manifest.json' with { type: 'json' };

const openWorkbench = startWorkbench();
const siteFolder = new URL('../../artifacts/site/engines/java/', import.meta.url);

async function measureBrotli(name: string): Promise<number> {
    const bytes = await findSiteFile(`/engines/java/${name}`).bytes();

    return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }).length;
}

test("site lists the java engine and has the java engine's manifest", async () => {
    expect(await findSiteFile('/engines/index.json').json()).toContain('java');
    expect(readManifest(await findSiteFile('/engines/java/manifest.json').json())).toEqual(readManifest(manifest));
});

test("java engine's worker gets ready on the site without a policy violation", async () => {
    const { page, violations } = await openWorkbench();

    const message = await page.evaluate(() => {
        // makes the URL a trusted one because the site's policy requires trusted types for a worker's script
        const trusted = window.trustedTypes!.createPolicy('worker.test', { createScriptURL: url => url });
        // casts the trusted URL because TypeScript's `Worker` only takes a string or a `URL`
        const worker = new Worker(trusted.createScriptURL('engines/java/worker.js') as unknown as URL, { type: 'module' });

        return new Promise(resolve => worker.addEventListener('message', event => resolve(event.data), { once: true }));
    });

    expect(message).toEqual({ ready: true });
    expect(violations).toEqual([]);
}, testTimeoutMs);

test("java engine's folder holds its manifest, its worker and the chunks of its shared code, its bytecode and Vineflower, each small", async () => {
    const names = readdirSync(siteFolder).sort();
    const findChunk = (prefix: string) => names.find(name => name.startsWith(prefix))!;
    const workerBytes = (await measureBrotli('worker.js')) + (await measureBrotli(findChunk('worker-')));

    const kinds = names.map(name => name.replace(/-[^-]+\.js$/, '-*.js'));

    expect(kinds).toEqual(['bytecode-*.js', 'manifest.json', 'vf.runtime-*.js', 'worker-*.js', 'worker.js']);
    expect(workerBytes).toBeLessThanOrEqual(24_000);
    expect(await measureBrotli(findChunk('bytecode-'))).toBeLessThanOrEqual(8_000);
    expect(await measureBrotli(findChunk('vf.runtime-'))).toBeLessThanOrEqual(450_000);
});
