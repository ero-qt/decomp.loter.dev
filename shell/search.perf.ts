import { expect, test } from 'bun:test';
import { readUntil } from './editor-testing';
import { pickMatches } from './matches';
import { startWorkbench, testTimeoutMs } from './page-testing';
import { dropAndWait } from './tree-testing';

const openWorkbench = startWorkbench();

function writeClasses(count: number): string {
    return `fake\n${Array.from({ length: count }, (_, index) => `public class Class${index}\n`).join('')}`;
}

test('pickMatches picks 500 of 100,000 texts', () => {
    const items = Array.from({ length: 100_000 }, (_, index) => ({ text: `Class${index}` }));
    const start = performance.now();

    expect(pickMatches(items, 'class', 500)).toHaveLength(500);
    console.log(`pickMatches took ${Math.round(performance.now() - start)} ms`);
});

test('Ctrl+T finds a class in each of 2 files with 100,000 classes', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'first.fake': writeClasses(100_000), 'second.fake': writeClasses(100_000) });
    const start = performance.now();

    await page.keyboard.press('Control+T');
    await page.keyboard.insertText('Class99999');

    const expected = ['Class99999 first.fake', 'Class99999 second.fake'];
    const read = () => page.locator('.quick-input-list .monaco-list-row').evaluateAll(rows => rows.map(row => {
        return `${row.querySelector('.label-name')?.textContent} ${row.querySelector('.label-description')?.textContent}`;
    }).sort());
    expect(await readUntil(read, expected)).toEqual(expected);
    const heapBytes = await page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize);
    console.log(`the search took ${Math.round(performance.now() - start)} ms with a heap of ${Math.round(heapBytes / 1e6)} MB`);
}, 2 * testTimeoutMs);
