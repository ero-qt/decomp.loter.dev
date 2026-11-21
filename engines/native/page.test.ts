import { expect, test } from 'bun:test';
import { readLines, readUntil, readWordColor, waitForTabs } from '../../shell/editor-testing';
import { listOtherHostRequests, startWorkbench, testTimeoutMs } from '../../shell/page-testing';
import { dropFiles, expandRows, findRow, readRowTexts } from '../../shell/tree-testing';
import { readFixture } from './testing';

const openWorkbench = startWorkbench();
const shapes = await (await readFixture('shapes-x64.so')).bytes();
const dll = await (await readFixture('shapes.dll')).bytes();
const pdb = await (await readFixture('shapes.pdb')).bytes();
const nativeFiles = /\/engines\/native\/(?!manifest\.json)/;
// waits longer than the other page tests because the worker compiles a 10 MB module and Ghidra loads its language
const nativeTimeoutMs = testTimeoutMs * 4;

test("dropped elf file lists its namespace and classes, and a click on a class opens its C with the theme's colors", async () => {
    const { page, violations, requests } = await openWorkbench();

    await dropFiles(page, { 'shapes-x64.so': shapes });
    await expandRows(page, 'shapes-x64.so', 'geometry');
    await findRow(page, 'Rect').click();
    await waitForTabs(page, 'About', 'Rect.c');
    const areaLine = await readUntil(async () => (await readLines(page)).find(line => line.includes('geometry::Rect::area(')) !== undefined, true);

    expect(areaLine).toBe(true);
    const signature = (await readLines(page)).find(line => line.includes('geometry::Rect::area('))!;
    expect(await readUntil(() => readWordColor(page, signature, 'geometry::Rect::area'), '#dcd2a5')).toBe('#dcd2a5');
    expect(await readUntil(() => readWordColor(page, 'return ', 'return'), '#d48aad')).toBe('#d48aad');
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, nativeTimeoutMs);

test('workbench loads the native worker and module only after a drop, and the language and C grammar only for a C document', async () => {
    const { page, requests } = await openWorkbench();
    const startRequests = [...requests];

    await dropFiles(page, { 'shapes-x64.so': shapes });
    await expandRows(page, 'shapes-x64.so', 'geometry');
    const listedRequests = [...requests];

    await findRow(page, 'Rect').click();
    await waitForTabs(page, 'About', 'Rect.c');
    await readUntil(() => readWordColor(page, 'return ', 'return'), '#d48aad');
    const language = requests.filter(url => url.endsWith('/engines/native/sleigh/x86/x86-64.sla'));
    const grammar = requests.filter(url => /\/c\.tmLanguage/.test(url));

    expect(startRequests.filter(url => nativeFiles.test(url))).toEqual([]);
    expect(listedRequests.some(url => url.endsWith('/engines/native/worker.js'))).toBe(true);
    expect(listedRequests.some(url => url.endsWith('/engines/native/rizin.mjs'))).toBe(true);
    expect(listedRequests.some(url => url.endsWith('/engines/native/rizin.wasm'))).toBe(true);
    expect(language.length).toBeGreaterThanOrEqual(1);
    expect(grammar.length).toBeGreaterThanOrEqual(1);
    expect(listedRequests.filter(url => language.includes(url) || grammar.includes(url))).toEqual([]);
}, nativeTimeoutMs);

test("dropped dll shows its missing pdb, and the pdb picked from the missing file's row adds the dll's static functions", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'shapes.dll': dll });
    await expandRows(page, 'shapes.dll');
    await findRow(page, 'shapes.pdb').waitFor();
    const before = await readRowTexts(page);

    const chooser = page.waitForEvent('filechooser');
    await findRow(page, 'shapes.pdb').click();
    await (await chooser).setFiles({ name: 'shapes.pdb', mimeType: 'application/octet-stream', buffer: Buffer.from(pdb) });
    await findRow(page, 'shapes.pdb').waitFor({ state: 'detached' });
    await findRow(page, 'classify').waitFor();

    expect(before).toContain('shapes.pdb not loaded');
    expect(before).not.toContain('classify');
    expect(await readRowTexts(page)).toContain('geometry');
}, nativeTimeoutMs);
