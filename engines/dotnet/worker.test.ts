import { readdirSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';
import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { findRow } from '../../contract/checking';
import { formatTarget } from '../../contract/document';
import { readManifest } from '../../contract/manifest';
import { readRows } from '../../contract/rows';
import { findSiteFile, listOtherHostRequests, startWorkbench, testTimeoutMs } from '../../shell/page-testing';
import manifest from './manifest.json' with { type: 'json' };
import { compileAssembly, readFixture } from './testing';

const openWorkbench = startWorkbench();
const siteFolder = new URL('../../artifacts/site/engines/dotnet/', import.meta.url);
const drawing = await readFixture('Drawing.dll');

// the page's functions that send a call to the engine's worker and cancel the running call
interface TestWindow {
    callEngine(message: unknown): Promise<unknown>;
    cancelEngine(): void;
}

// starts the engine's worker in the page and waits for its `ready`, with `callEngine` on the page's window
async function startWorker(page: Page) {
    return page.evaluate(() => {
        // makes the URL a trusted one because the site's policy requires trusted types for a worker's script
        const trusted = window.trustedTypes!.createPolicy('worker.test', { createScriptURL: url => url });
        // casts the trusted URL because TypeScript's `Worker` only takes a string or a `URL`
        const worker = new Worker(trusted.createScriptURL('engines/dotnet/worker.js') as unknown as URL, { type: 'module' });
        const nextMessage = () =>
            new Promise(resolve => worker.addEventListener('message', event => resolve(event.data), { once: true }));
        (window as unknown as TestWindow).callEngine = message => {
            const reply = nextMessage();
            worker.postMessage(message);

            return reply;
        };
        (window as unknown as TestWindow).cancelEngine = () => worker.postMessage({ cancel: true });

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
    const bytes = await findSiteFile(`/engines/dotnet/${path}`).bytes();

    return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }).length;
}

test("site lists the dotnet engine and has the dotnet engine's manifest", async () => {
    expect(await findSiteFile('/engines/index.json').json()).toContain('dotnet');
    expect(readManifest(await findSiteFile('/engines/dotnet/manifest.json').json())).toEqual(readManifest(manifest));
});

test("dotnet engine's worker gets ready on the site without loading the runtime's files", async () => {
    const { page, violations, requests } = await openWorkbench();

    expect(await startWorker(page)).toEqual({ ready: true });
    expect(requests.filter(url => url.includes('/engines/dotnet/_framework/'))).toEqual([]);
    expect(violations).toEqual([]);
}, testTimeoutMs);

test("dotnet engine's worker opens Drawing.dll in the page and writes Painter's C# without a policy violation", async () => {
    const { page, violations, requests } = await openWorkbench();
    await startWorker(page);

    const painter = findRow(await openInPage(page, drawing), 'Drawing.Painter', drawing.name);
    const text = await page.evaluate(async key => {
        const { reply } = (await (window as unknown as TestWindow).callEngine({ method: 'read', args: [1, key, 'csharp'] })) as {
            reply: { value: { text: string } };
        };

        return reply.value.text;
    }, painter.key);

    expect(text).toContain('public class Painter\n');
    expect(requests.some(url => url.includes('/engines/dotnet/_framework/dotnet.native.'))).toBe(true);
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, testTimeoutMs * 2);

test("dotnet engine's worker in the page stops a search for users once the page cancels it", async () => {
    const { page } = await openWorkbench();
    await startWorker(page);
    const assembly = await compileAssembly(
        'PageMany',
        'public static class Target { public static int Value; } '
            + Array.from({ length: 3000 }, (_, index) => `public class C${index} { public int M() { return Target.Value; } }`).join(' '),
    );
    const value = formatTarget({ fileId: 1, key: findRow(await openInPage(page, assembly), 'Target.Value', assembly.name).key });

    // times a search first because the worker only sees the cancel once the search passed the 50 ms between its checks
    const [searchMs, ...replies] = await page.evaluate(async target => {
        const { callEngine, cancelEngine } = window as unknown as TestWindow;
        const search = { method: 'findReferences', args: [target, 'csharp'] };
        const start = performance.now();
        const first = (await callEngine(search)) as { reply: { value: unknown[] } };
        const end = performance.now();
        const canceled = callEngine(search);
        setTimeout(cancelEngine, 5);
        const second = (await canceled) as { reply: { value?: unknown[]; error?: string } };

        return [end - start, first.reply.value.length, second.reply.error];
    }, value);

    expect(searchMs).toBeGreaterThan(200);
    expect(replies).toEqual([3000, 'The call was canceled.']);
}, testTimeoutMs * 4);

test("dotnet engine's folder holds a small worker, the runtime and its notices", async () => {
    const paths = readdirSync(siteFolder, { recursive: true, encoding: 'utf8' }).filter(path => !path.endsWith('_framework'));
    const sizes = await Promise.all(paths.map(path => measureBrotli(path)));

    expect(paths).toEqual(expect.arrayContaining(['manifest.json', 'worker.js', 'THIRD-PARTY-NOTICES.TXT', '_framework/dotnet.js']));
    expect(paths.length).toBeLessThanOrEqual(34);
    expect(await measureBrotli('worker.js')).toBeLessThanOrEqual(20_000);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(3_650_000);
});
