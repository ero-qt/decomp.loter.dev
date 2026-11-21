import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { readLines, readUntil, readWordColor, waitForTabs } from '../../shell/editor-testing';
import { listOtherHostRequests, startWorkbench, testTimeoutMs } from '../../shell/page-testing';
import { dropFiles, expandRows, findRow, readRowIcon } from '../../shell/tree-testing';
import { fixture } from './fixture';

const openWorkbench = startWorkbench();
const drawing = await fixture.file.bytes();
// the start of the class codicon's path, which the icon of a class's row draws
const classIconPath = 'M13.2069 10.4999';
const mainLine = 'public final class Main {';
// a name in the TextMate worker's code
const textMateWorkerText = 'textMateWorkerHost';
const javaWorker = /\/engines\/java\/worker\.js$/;
const vineflowerChunk = /\/engines\/java\/vf\.runtime-[^/]+\.js$/;

// returns the workers whose code has the text, because the URLs of most workers only have a hash after a generic name
async function findWorkers(page: Page, urls: string[], text: string): Promise<string[]> {
    const codes = await Promise.all(urls.map(url => page.evaluate(async workerUrl => (await fetch(workerUrl)).text(), url)));

    return urls.filter((_, index) => codes[index].includes(text));
}

// drops `drawing.jar` and opens `Main.java` from the class's row
async function openMain(page: Page) {
    await dropFiles(page, { 'drawing.jar': drawing });
    await expandRows(page, 'drawing.jar', 'drawing');
    await findRow(page, 'Main').click();
    await waitForTabs(page, 'About', 'Main.java');
}

test("dropped JAR lists its packages and classes, and a click on a class opens the class's Java with the theme's class color", async () => {
    const { page, violations, requests } = await openWorkbench();

    await openMain(page);

    expect(await readRowIcon(page, 'Main')).toContain(classIconPath);
    expect(await readUntil(async () => (await readLines(page)).includes(mainLine), true)).toBe(true);
    expect(await readUntil(() => readWordColor(page, mainLine, 'Main'), '#56c9a2')).toBe('#56c9a2');
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, testTimeoutMs);

test("Java's keywords, strings and numbers have the theme's colors from the Java grammar", async () => {
    const { page, violations } = await openWorkbench();

    await openMain(page);

    expect(await readUntil(() => readWordColor(page, mainLine, 'public'), '#609fd2')).toBe('#609fd2');
    expect(await readUntil(() => readWordColor(page, '"large"', '"large"'), '#c7988b')).toBe('#c7988b');
    expect(await readUntil(() => readWordColor(page, '10.0 ?', '10.0'), '#deb684')).toBe('#deb684');
    expect(violations).toEqual([]);
}, testTimeoutMs);

test(
    'workbench loads the Java grammar, its wasm, the TextMate worker and the Java worker only after start, and Vineflower only for a Java document',
    async () => {
        const { page, requests } = await openWorkbench();
        const startRequests = [...requests];

        await dropFiles(page, { 'drawing.jar': drawing });
        await expandRows(page, 'drawing.jar', 'drawing');
        const listedRequests = [...requests];

        await findRow(page, 'Main').click();
        await waitForTabs(page, 'About', 'Main.java');
        await readUntil(() => readWordColor(page, mainLine, 'public'), '#609fd2');
        const workers = page.workers().map(worker => worker.url());
        const textMateWorkers = await findWorkers(page, workers, textMateWorkerText);
        const grammar = requests.filter(url => /java\.tmLanguage|onig/.test(url));
        const vineflower = requests.filter(url => vineflowerChunk.test(url));

        expect(textMateWorkers).toHaveLength(1);
        expect(workers.filter(url => javaWorker.test(url))).toHaveLength(1);
        expect(grammar.length).toBeGreaterThanOrEqual(2);
        expect(vineflower).toHaveLength(1);
        expect(listedRequests.filter(url => vineflower.includes(url))).toEqual([]);
        expect(startRequests.filter(url => [...workers, ...grammar].includes(url))).toEqual([]);
    },
    testTimeoutMs,
);
