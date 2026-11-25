import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { Engine } from '#contract/engine';
import { fakeManifest } from '#contract/fake';
import * as queue from '#contract/queue';
import { findEngine, formatWorkerUrl, listExtensions, loadEngines, type SiteEngine } from './engines';

const siteUrl = 'https://decomp.example/site/';

let claimsCallNames: string[] = [];

afterEach(() => mock.restore());

function createEngine(name: string, extensions: string[], claims: boolean, magics?: string[]): SiteEngine {
    const engine: Pick<Engine, 'claims'> = {
        async claims() {
            claimsCallNames.push(name);

            return claims;
        },
    };

    return { manifest: { ...fakeManifest, name, extensions, magics }, engine: engine as Engine };
}

async function findEngineName(engines: SiteEngine[], fileName: string, bytes: number[] = []): Promise<string | undefined> {
    claimsCallNames = [];

    return (await findEngine(engines, new File([new Uint8Array(bytes)], fileName)))?.manifest.name;
}

// path below the site -> the JSON of the site's file
function serveSite(files: Record<string, unknown>) {
    spyOn(globalThis, 'fetch').mockImplementation((async (url: URL) => {
        const path = url.href.slice(siteUrl.length);

        return path in files ? Response.json(files[path]) : new Response(null, { status: 404 });
    }) as unknown as typeof fetch);
}

test("findEngine returns the first engine that has the extension of the file's name and claims the file", async () => {
    const engines = [
        createEngine('first', ['.fake'], false),
        createEngine('second', ['.code', '.fake'], true),
        createEngine('third', ['.fake'], true),
    ];

    expect(await findEngineName(engines, 'shapes.fake')).toBe('second');
    expect(claimsCallNames).toEqual(['first', 'second']);
});

test("findEngine doesn't call `claims` of an engine without the extension of the file's name", async () => {
    const engines = [createEngine('first', ['.ops'], true), createEngine('second', ['.fake'], true)];

    expect(await findEngineName(engines, 'shapes.fake')).toBe('second');
    expect(claimsCallNames).toEqual(['second']);
});

test('findEngine matches an extension without its case and only at the end of the name', async () => {
    const engines = [createEngine('first', ['.fake'], true)];

    expect(await findEngineName(engines, 'SHAPES.FAKE')).toBe('first');
    expect(await findEngineName(engines, 'shapes.fake.txt')).toBeUndefined();
});

test("findEngine returns `undefined` for a file that the engines with the extension don't claim", async () => {
    expect(await findEngineName([createEngine('first', ['.fake'], false)], 'shapes.fake')).toBeUndefined();
    expect(claimsCallNames).toEqual(['first']);
});

test('findEngine asks an engine whose magic starts a file without a listed extension', async () => {
    const engines = [createEngine('first', ['.fake'], true), createEngine('native', ['.so'], true, ['cafebabe', '7f454c46'])];

    expect(await findEngineName(engines, 'ls', [0x7f, 0x45, 0x4c, 0x46, 2])).toBe('native');
    expect(claimsCallNames).toEqual(['native']);
    expect(await findEngineName(engines, 'ls', [0x7f, 0x45, 0x4c])).toBeUndefined();
    expect(claimsCallNames).toEqual([]);
});

test("findEngine matches only extensions for a file whose start the page can't read", async () => {
    const engines = [createEngine('native', ['.so'], true, ['7f454c46']), createEngine('first', ['.fake'], true)];
    const file = new File([new Uint8Array([0x7f, 0x45, 0x4c, 0x46])], 'shapes.fake');
    spyOn(file, 'slice').mockReturnValue({ arrayBuffer: () => Promise.reject(new Error('The file was moved.')) } as unknown as Blob);

    expect((await findEngine(engines, file))?.manifest.name).toBe('first');
});

test("listExtensions lists each extension in the engines' manifests once", () => {
    const engines = [createEngine('first', ['.fake', '.code'], true), createEngine('second', ['.ops', '.fake'], true)];

    expect(listExtensions(engines)).toEqual(['.fake', '.code', '.ops']);
});

test('listExtensions lists no extension when an engine has magics', () => {
    const engines = [createEngine('first', ['.fake'], true), createEngine('native', ['.so'], true, ['7f454c46'])];

    expect(listExtensions(engines)).toEqual([]);
});

test("formatWorkerUrl returns the worker URL of an engine in the site's index", () => {
    expect(formatWorkerUrl('fake', ['other', 'fake'], siteUrl)).toBe('https://decomp.example/site/engines/fake/worker.js');
});

test("formatWorkerUrl refuses an id that isn't in the site's index or has other characters than a-z, 0-9 and -", () => {
    for (const id of ['other', '../elsewhere', 'fake/../other', 'https://other.example']) {
        expect(() => formatWorkerUrl(id, ['fake', id.replace('other', 'outside')], siteUrl))
            .toThrow(`'${id}' isn't the id of one of the site's engines`);
    }
});

test("loadEngines loads the engines of the site's index in the index's order", async () => {
    serveSite({
        'engines/index.json': ['other', 'fake'],
        'engines/other/manifest.json': { ...fakeManifest, id: 'other' },
        'engines/fake/manifest.json': fakeManifest,
    });

    const { engines, errorTexts } = await loadEngines(siteUrl);

    expect(engines.map(({ manifest }) => manifest.id)).toEqual(['other', 'fake']);
    expect(errorTexts).toEqual([]);
});

test('loadEngines connects an engine with the memory limit and linked files of its manifest', async () => {
    const connectEngine = spyOn(queue, 'connectEngine');
    serveSite({
        'engines/index.json': ['fake'],
        'engines/fake/manifest.json': { ...fakeManifest, memoryLimitBytes: 1000 },
    });

    await loadEngines(siteUrl);

    expect(connectEngine).toHaveBeenCalledWith(expect.anything(), {
        timeLimitMs: expect.any(Number),
        cancelLimitMs: expect.any(Number),
        memoryLimitBytes: 1000,
        hasLinkedFiles: true,
    });
});

test('loadEngines connects an engine with the cancel limit of its manifest and with the default limit without one', async () => {
    const connectEngine = spyOn(queue, 'connectEngine');
    serveSite({
        'engines/index.json': ['fake', 'other'],
        'engines/fake/manifest.json': { ...fakeManifest, cancelLimitMs: 10000 },
        'engines/other/manifest.json': { ...fakeManifest, id: 'other' },
    });

    await loadEngines(siteUrl);

    expect(connectEngine.mock.calls.map(([, options]) => options.cancelLimitMs)).toEqual([10000, 1000]);
});

test("loadEngines puts an engine with a higher priority before the index's order", async () => {
    serveSite({
        'engines/index.json': ['fake', 'other', 'third'],
        'engines/fake/manifest.json': fakeManifest,
        'engines/other/manifest.json': { ...fakeManifest, id: 'other', priority: 1 },
        'engines/third/manifest.json': { ...fakeManifest, id: 'third' },
    });

    const { engines } = await loadEngines(siteUrl);

    expect(engines.map(({ manifest }) => manifest.id)).toEqual(['other', 'fake', 'third']);
});

test("loadEngines leaves out an engine that doesn't load and returns a text with the engine's id and error", async () => {
    serveSite({
        'engines/index.json': ['broken', 'fake', 'renamed', '../elsewhere'],
        'engines/fake/manifest.json': fakeManifest,
        'engines/renamed/manifest.json': fakeManifest,
        'elsewhere/manifest.json': fakeManifest,
    });

    const { engines, errorTexts } = await loadEngines(siteUrl);

    expect(engines.map(({ manifest }) => manifest.id)).toEqual(['fake']);
    expect(errorTexts).toEqual([
        "The site couldn't load the engine 'broken' (the site doesn't have /site/engines/broken/manifest.json).",
        "The site couldn't load the engine 'renamed' (the manifest has the id 'fake').",
        "The site couldn't load the engine '../elsewhere' ('../elsewhere' isn't the id of one of the site's engines).",
    ]);
});

test("loadEngines returns an error text for an index that the site doesn't have or that isn't a list of strings", async () => {
    serveSite({});
    const missing = await loadEngines(siteUrl);
    serveSite({ 'engines/index.json': ['fake', 1] });
    const broken = await loadEngines(siteUrl);

    expect(missing.errorTexts).toEqual(["The site couldn't load its engines (the site doesn't have /site/engines/index.json)."]);
    expect(broken.errorTexts).toEqual(["The site couldn't load its engines (engines/index.json isn't a list of strings)."]);
    expect([...missing.engines, ...broken.engines]).toEqual([]);
});
