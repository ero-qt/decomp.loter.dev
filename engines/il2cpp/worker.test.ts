import { findRow } from '#contract/checking';
import { readManifest } from '#contract/manifest';
import { readRows } from '#contract/rows';
import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';
import type { Page } from 'playwright';
import { findSiteFile, listOtherHostRequests, startWorkbench, testTimeoutMs } from '../../shell/page-testing';
import manifest from './manifest.json' with { type: 'json' };
import { readFixture } from './testing';

const openWorkbench = startWorkbench();
const siteFolder = new URL('../../artifacts/site/engines/il2cpp/', import.meta.url);
const metadata = await readFixture('global-metadata.dat');

// the page's function that sends a call to the engine's worker
interface TestWindow {
    callEngine(message: unknown): Promise<unknown>;
}

// starts the engine's worker in the page and waits for its `ready`, with `callEngine` on the page's window
async function startWorker(page: Page) {
    return page.evaluate(() => {
        // makes the URL a trusted one because the site's policy requires trusted types for a worker's script
        const trusted = window.trustedTypes!.createPolicy('worker.test', { createScriptURL: url => url });
        // casts the trusted URL because TypeScript's `Worker` only takes a string or a `URL`
        const worker = new Worker(trusted.createScriptURL('engines/il2cpp/worker.js') as unknown as URL, { type: 'module' });
        const nextMessage = () =>
            new Promise(resolve => worker.addEventListener('message', event => resolve(event.data), { once: true }));
        (window as unknown as TestWindow).callEngine = message => {
            const reply = nextMessage();
            worker.postMessage(message);

            return reply;
        };

        return nextMessage();
    });
}

// opens the bytes as file 1 in the page's worker and returns the file's rows
async function openInPage(page: Page, file: File) {
    const bytes = [...(await file.bytes())];
    const listing = await page.evaluate(
        async ({ name, bytes }) => {
            const { callEngine } = window as unknown as TestWindow;
            await callEngine({ method: 'open', args: [1, name, new Blob([new Uint8Array(bytes)])] });
            const { reply } = (await callEngine({ method: 'list', args: [1] })) as {
                reply: { value: { values: Int32Array; names: string[]; details: string[] } };
            };

            return { ...reply.value, values: [...reply.value.values] };
        },
        { name: file.name, bytes },
    );

    return readRows({ ...listing, values: Int32Array.from(listing.values) });
}

async function measureBrotli(path: string): Promise<number> {
    const bytes = await findSiteFile(`/engines/il2cpp/${path}`).bytes();

    return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }).length;
}

test("site lists the il2cpp engine and has the il2cpp engine's manifest", async () => {
    expect(await findSiteFile('/engines/index.json').json()).toContain('il2cpp');
    expect(readManifest(await findSiteFile('/engines/il2cpp/manifest.json').json())).toEqual(readManifest(manifest));
});

test("il2cpp engine's worker gets ready on the site without loading the runtime's files", async () => {
    const { page, violations, requests } = await openWorkbench();

    expect(await startWorker(page)).toEqual({ ready: true });
    expect(requests.filter(url => url.includes('/_framework/'))).toEqual([]);
    expect(violations).toEqual([]);
}, testTimeoutMs);

test("il2cpp engine's worker opens the metadata in the page and writes Circle's stub without a policy violation", async () => {
    const { page, violations, requests } = await openWorkbench();
    await startWorker(page);

    const circle = findRow(await openInPage(page, metadata), 'Assembly-CSharp.dll.Shapes.Circle', metadata.name);
    const text = await page.evaluate(async key => {
        const { reply } = (await (window as unknown as TestWindow).callEngine({ method: 'read', args: [1, key, 'csharp'] })) as {
            reply: { value: { text: string } };
        };

        return reply.value.text;
    }, circle.key);

    expect(text).toContain('public class Circle\n');
    expect(requests.some(url => url.includes('/engines/dotnet/_framework/dotnet.native.'))).toBe(true);
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, testTimeoutMs * 2);

test("il2cpp engine's folder holds a small worker, but not a runtime of its own", async () => {
    const paths = readdirSync(siteFolder, { recursive: true, encoding: 'utf8' });
    const sizes = await Promise.all(paths.map(path => measureBrotli(path)));

    expect(paths).toEqual(expect.arrayContaining(['manifest.json', 'worker.js']));
    expect(paths.filter(path => path.startsWith('_framework') || path === 'THIRD-PARTY-NOTICES.TXT')).toEqual([]);
    expect(await measureBrotli('worker.js')).toBeLessThanOrEqual(10_000);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(30_000);
});
