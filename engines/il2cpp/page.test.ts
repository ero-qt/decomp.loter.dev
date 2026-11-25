import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { readCursor, readLines, readUntil, readWordColor, waitForTabs } from '../../shell/editor-testing';
import { listOtherHostRequests, startWorkbench, testTimeoutMs } from '../../shell/page-testing';
import { dropFiles, expandRows, findRow, readRowTexts } from '../../shell/tree-testing';
import { readFixture } from './testing';

const openWorkbench = startWorkbench();
const metadata = await (await readFixture('global-metadata.dat')).bytes();
const binary = await (await readFixture('GameAssembly.dll')).bytes();

// drops the metadata and opens `Circle.cs` from the type's row
async function openCircle(page: Page) {
    await dropFiles(page, { 'global-metadata.dat': metadata });
    await expandRows(page, 'global-metadata.dat', 'Assembly-CSharp.dll', 'Shapes');
    await findRow(page, 'Circle').click();
    await waitForTabs(page, 'About', 'Circle.cs');
}

// checks that the metadata's row of the missing binary went away and that the metadata's row has the layout of the
// game that the engine read with the binary
function isBinaryLoaded(page: Page): () => Promise<boolean> {
    return async () => {
        const texts = await readRowTexts(page);

        return texts.some(text => text.startsWith('global-metadata.dat metadata')) && !texts.some(text => text.includes('not loaded'));
    };
}

test("dropped metadata lists its images and types, and a click on a type opens its stub with the theme's colors", async () => {
    const { page, violations, requests } = await openWorkbench();
    const circleLine = 'public class Circle';

    await openCircle(page);

    expect(await readUntil(async () => (await readLines(page)).includes(circleLine), true)).toBe(true);
    expect(await readUntil(() => readWordColor(page, circleLine, 'Circle'), '#56c9a2')).toBe('#56c9a2');
    expect(await readUntil(() => readWordColor(page, circleLine, 'public'), '#609fd2')).toBe('#609fd2');
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, testTimeoutMs * 2);

test("a click on an accessor's row opens the stub with the cursor on the accessor's property", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'global-metadata.dat': metadata });
    await expandRows(page, 'global-metadata.dat', 'Assembly-CSharp.dll', 'Shapes', 'Circle', 'Radius');

    await findRow(page, 'get_Radius()').click();
    await waitForTabs(page, 'About', 'Circle.cs');

    // the stub writes `Radius { get; set; }` on line 11, below the 2 lines of the note about the missing binary
    expect(await readUntil(() => readCursor(page), 'Ln 11, Col 19')).toBe('Ln 11, Col 19');
}, testTimeoutMs * 2);

test("GameAssembly.dll dropped first lists the game's metadata, which pairs with it once picked on that row", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'GameAssembly.dll': binary });
    await expandRows(page, 'GameAssembly.dll');
    const metadataRow = findRow(page, 'global-metadata.dat');
    await metadataRow.waitFor();
    const missingRows = ['global-metadata.dat IL2CPP metadata, not loaded', 'script.json IL2CPP names, not loaded'];
    expect(await readRowTexts(page)).toEqual(expect.arrayContaining(missingRows));

    const chooser = page.waitForEvent('filechooser');
    await metadataRow.click();
    await (await chooser).setFiles({ name: 'global-metadata.dat', mimeType: 'application/octet-stream', buffer: Buffer.from(metadata) });

    // the il2cpp engine takes the open binary, whose own file in the native engine then closes
    const isPaired = async () => {
        const texts = await readRowTexts(page);

        return texts.length === 1 && texts[0].startsWith('global-metadata.dat');
    };
    expect(await readUntil(isPaired, true)).toBe(true);
}, testTimeoutMs * 2);
