import { sampleFiles } from '#contract/fake';
import type { WorkerRequest } from '#contract/serve';
import { expect, test } from 'bun:test';
import { readUntil, readWarnings } from './editor-testing';
import { startWorkbench, testTimeoutMs, waitForEngineReplies } from './page-testing';
import { dropFiles, expandRows, findProgressStrip, readRowTexts, serveTestEngine, startWithEngines } from './tree-testing';

const openWorkbench = startWorkbench();
const drawing = await sampleFiles.drawing.text();

/**
 * Serves an engine that claims each file whose name ends with `.dat` and lists the missing companion file
 * `GameAssembly.dll`, which also goes by the name `libil2cpp.so`, until `provide` gets it.
 */
function serveGameEngine() {
    let isProvided = false;
    onmessage = function ({ data }: MessageEvent<WorkerRequest>) {
        // ignores a cancel message because the engine finishes each call
        if ('cancel' in data) {
            return;
        }

        const { method, args } = data;
        isProvided ||= method === 'provide';
        const binaryFile = { name: 'GameAssembly.dll', otherNames: ['libil2cpp.so'], reason: 'not loaded', isCompanion: true };
        const listing = { values: new Int32Array(), names: [], details: [], note: '', missingFiles: isProvided ? [] : [binaryFile] };
        // method -> the method's value
        const values: Record<string, unknown> = { claims: String(args[0]).endsWith('.dat'), list: listing, listStrings: [] };
        postMessage({ reply: { value: values[method] } });
    };

    postMessage({ ready: true });
}

test('file dropped beside a file that misses it as a companion goes to provide without a warning', async () => {
    const { page } = await openWorkbench();

    await dropFiles(page, { 'drawing.fake': drawing, 'drawing.notes': 'A note.' });
    await expandRows(page, 'drawing.fake');

    const expected = ['drawing.fake 1 class left out', 'shapes.fake not loaded', 'Drawing'];
    expect(await readUntil(() => readRowTexts(page), expected)).toEqual(expected);
    await waitForEngineReplies(page, 'provide');
    expect(await readWarnings(page)).toEqual([]);
}, testTimeoutMs);

test('companion dropped beside its file also opens in the engine that claims it', async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { fake: null, notes: { extensions: ['.notes'], serve: serveTestEngine } });

    await dropFiles(page, { 'drawing.fake': drawing, 'drawing.notes': 'A note.' });
    await expandRows(page, 'drawing.fake');

    const expected = ['drawing.fake 1 class left out', 'shapes.fake not loaded', 'Drawing', 'drawing.notes'];
    expect(await readUntil(() => readRowTexts(page), expected)).toEqual(expected);
    await waitForEngineReplies(page, 'provide');
}, testTimeoutMs);

test('files of 2 folders dropped together each go to the file in their own folder', async () => {
    const { page } = await openWorkbench();

    await dropFiles(page, {
        'a/a.fake': 'fake\nneeds drawing.notes\nnamespace A\n',
        'a/drawing.notes': 'A note.',
        'b/b.fake': 'fake\nneeds drawing.notes\nnamespace B\n',
        'b/drawing.notes': 'B note.',
    });
    await expandRows(page, 'a.fake', 'b.fake');
    await waitForEngineReplies(page, 'provide', 2);
    await findProgressStrip(page).waitFor({ state: 'hidden' });

    expect(await readUntil(() => readRowTexts(page), ['a.fake', 'A', 'b.fake', 'B'])).toEqual(['a.fake', 'A', 'b.fake', 'B']);
    expect(await readWarnings(page)).toEqual([]);
}, testTimeoutMs);

test("file dropped beside a file that misses it under another of the companion's names goes to provide", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { fake: null, game: { extensions: ['.dat'], serve: serveGameEngine } });

    await dropFiles(page, { 'global-metadata.dat': '', 'libil2cpp.so': 'ELF' });
    await waitForEngineReplies(page, 'provide');

    expect(await readRowTexts(page)).toEqual(['global-metadata.dat']);
    expect(await readWarnings(page)).toEqual([]);
}, testTimeoutMs);

test("companion dropped beside a file whose engine keeps its companions doesn't open in the engine that claims it", async () => {
    const { page } = await openWorkbench();
    const game = { extensions: ['.dat'], keepsCompanions: true, serve: serveGameEngine };
    await startWithEngines(page, { fake: null, game, binary: { extensions: ['.dll'], serve: serveTestEngine } });
    const readMethods = () => page.evaluate(() => (window as unknown as { engineCalls: { methods: string[] } }).engineCalls.methods);

    await dropFiles(page, { 'GameAssembly.dll': 'MZ', 'global-metadata.dat': '' });
    await waitForEngineReplies(page, 'provide');
    await findProgressStrip(page).waitFor({ state: 'hidden' });

    expect((await readMethods()).filter(method => method === 'open')).toHaveLength(1);
    expect(await readRowTexts(page)).toEqual(['global-metadata.dat']);
    expect(await readWarnings(page)).toEqual([]);
}, testTimeoutMs);

test('open file closes once it goes to a file that opens later and keeps its companions', async () => {
    const { page } = await openWorkbench();
    const game = { extensions: ['.dat'], keepsCompanions: true, serve: serveGameEngine };
    await startWithEngines(page, { fake: null, game, binary: { extensions: ['.dll'], serve: serveTestEngine } });

    await dropFiles(page, { 'GameAssembly.dll': 'MZ' });
    await waitForEngineReplies(page, 'open');
    await dropFiles(page, { 'global-metadata.dat': '' });
    await waitForEngineReplies(page, 'provide');

    expect(await readUntil(() => readRowTexts(page), ['global-metadata.dat'])).toEqual(['global-metadata.dat']);
    expect(await readWarnings(page)).toEqual([]);
}, testTimeoutMs);

test("file dropped later doesn't get a companion from another folder that went to another file", async () => {
    const { page } = await openWorkbench();
    await startWithEngines(page, { fake: null, notes: { extensions: ['.notes'], serve: serveTestEngine } });
    await dropFiles(page, { 'a/a.fake': 'fake\nneeds drawing.notes\nnamespace A\n', 'a/drawing.notes': 'A note.' });
    await waitForEngineReplies(page, 'provide');

    await dropFiles(page, { 'b/b.fake': 'fake\nneeds drawing.notes\nnamespace B\n' });
    await expandRows(page, 'b.fake');
    await waitForEngineReplies(page, 'open', 3);
    await findProgressStrip(page).waitFor({ state: 'hidden' });

    const { methods } = await page.evaluate(() => (window as unknown as { engineCalls: { methods: string[] } }).engineCalls);
    expect(methods.filter(method => method === 'provide')).toHaveLength(1);
    expect(await readRowTexts(page)).toContain('drawing.notes not loaded');
}, testTimeoutMs);
