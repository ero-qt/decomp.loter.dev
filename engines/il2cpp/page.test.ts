import { expect, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { findTab, findWord, readActiveTab, readCursor, readLines, readUntil, readWarnings, readWordColor, waitForTabs } from '../../shell/editor-testing';
import { listOtherHostRequests, startWorkbench, testTimeoutMs } from '../../shell/page-testing';
import { dropFiles, expandRows, findRow, readRowTexts } from '../../shell/tree-testing';
import { readBuildFile, realBuilds } from './real-builds';
import { readCodeGame, readFixture } from './testing';

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

// hovers over `Area()` in Circle's stub until the hover shows the method's addresses, because the hover can miss a
// pointer that sat still while the stub changed
async function hoverArea(page: Page): Promise<Locator> {
    const hover = page.locator('.monaco-editor .monaco-hover-content').filter({ visible: true, hasText: 'RVA' });
    const isShown = await readUntil(async () => {
        await page.mouse.move(0, 0);
        await findWord(page, 'public override float Area()', 'Area').hover();

        return hover.waitFor({ timeout: 2000 }).then(() => true, () => false);
    }, true);
    if (!isShown) {
        throw new Error("the hover of Area() doesn't show its addresses");
    }

    return hover;
}

// waits until the page stops reading the open stub again for a second, because the engine writes a stub's bodies in
// parts and a part that comes cancels the F12 that waits for the stub
async function waitForWholeStub(page: Page) {
    const countReads = async () => {
        const { methods } = await page.evaluate(() => (window as unknown as { engineCalls: { methods: string[] } }).engineCalls);

        return methods.filter(method => method === 'read').length;
    };
    for (let count = -1; count !== (await countReads()); ) {
        count = await countReads();
        await Bun.sleep(1000);
    }
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

test("a method with a compiler's name has its keywords in the theme's colors", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'global-metadata.dat': await (await readCodeGame('global-metadata.dat')).bytes() });
    await expandRows(page, 'global-metadata.dat', 'Assembly-CSharp.dll', 'Shapes');
    await findRow(page, 'Circle').click();
    await waitForTabs(page, 'About', 'Circle.cs');
    // the stub writes `object` for each type until the binary comes
    const stepLine = 'internal static object <Grow>g__Step|9_0()';

    expect(await readUntil(async () => (await readLines(page)).some(line => line.includes(stepLine)), true)).toBe(true);
    for (const keyword of ['internal', 'static', 'object']) {
        expect(await readUntil(() => readWordColor(page, stepLine, keyword), '#609fd2')).toBe('#609fd2');
    }
}, testTimeoutMs * 2);

test("a `<` in a body has the theme's color of an operator, not the color of a bracket without its pair", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'global-metadata.dat': await (await readCodeGame('global-metadata.dat')).bytes() });
    await dropFiles(page, { 'GameAssembly.dll': await (await readCodeGame('GameAssembly.dll')).bytes() });
    await expandRows(page, 'global-metadata.dat', 'Assembly-CSharp.dll', 'Shapes');
    await findRow(page, 'Circle').click();
    await waitForTabs(page, 'About', 'Circle.cs');
    await readUntil(async () => (await readLines(page)).some(line => line.trim().startsWith('return ')), true);
    await waitForWholeStub(page);

    // finds the line, which scrolls the stub to it
    const lengthLine = 'if (0 < (long)piVar1.Length) {';
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+F');
    await page.keyboard.insertText(lengthLine);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    expect(await readUntil(async () => (await readLines(page)).some(line => line.includes(lengthLine)), true)).toBe(true);
    expect(await readUntil(() => readWordColor(page, lengthLine, '<'), '#cccccc')).toBe('#cccccc');
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

test("GameAssembly.dll picked from the missing file's row adds the methods' C to the stubs and their addresses to the hover", async () => {
    const { page, violations } = await openWorkbench();
    await dropFiles(page, { 'global-metadata.dat': metadata });
    await expandRows(page, 'global-metadata.dat');
    await findRow(page, 'GameAssembly.dll').waitFor();

    const chooser = page.waitForEvent('filechooser');
    await findRow(page, 'GameAssembly.dll').click();
    await (await chooser).setFiles({ name: 'GameAssembly.dll', mimeType: 'application/octet-stream', buffer: Buffer.from(binary) });
    expect(await readUntil(isBinaryLoaded(page), true)).toBe(true);
    await expandRows(page, 'Assembly-CSharp.dll', 'Shapes');
    await findRow(page, 'Circle').click();
    await waitForTabs(page, 'About', 'Circle.cs');

    const circleLine = 'public class Circle : Shape, IDrawable';
    expect(await readUntil(async () => (await readLines(page)).includes(circleLine), true)).toBe(true);
    // the native engine's module, which the il2cpp engine loads from the native engine's folder, writes the bodies
    expect(await readUntil(async () => (await readLines(page)).some(line => line.trim().startsWith('return ')), true)).toBe(true);
    expect((await readLines(page)).some(line => line.includes('RVA'))).toBe(false);

    const hover = await hoverArea(page);
    const lines = (await hover.innerText()).split('\n').filter(line => line.trim() !== '');

    // shows the addresses on 1 line, each as code beside its label
    expect(lines).toEqual(expect.arrayContaining(['in Shapes.Circle', 'RVA 0x1050 · VA 0x180001050 · offset 0x450']));
    expect(await hover.locator('code').allInnerTexts()).toEqual(expect.arrayContaining(['0x1050', '0x180001050', '0x450']));
    expect(violations).toEqual([]);
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

test("F12 on a called method in a stub's C opens the stub of the method's type", async () => {
    const { page } = await openWorkbench();
    await dropFiles(page, { 'global-metadata.dat': metadata, 'GameAssembly.dll': binary });
    await expandRows(page, 'global-metadata.dat', 'Assembly-CSharp.dll');
    await findRow(page, 'Player').click();
    await waitForTabs(page, 'About', 'Player.cs');
    const callLine = 'this.Area()';
    expect(await readUntil(async () => (await readLines(page)).some(line => line.includes(callLine)), true)).toBe(true);

    await findWord(page, callLine, 'Area').click();
    await page.keyboard.press('F12');

    expect(await readUntil(() => readActiveTab(page), 'Circle.cs')).toBe('Circle.cs');
}, testTimeoutMs * 2);

test("F12 on a function of the binary in a stub's code opens the binary's own C, without the binary as a file of its own", async () => {
    const { page } = await openWorkbench();
    const build = realBuilds['2019.4.34'];
    await dropFiles(page, { 'global-metadata.dat': await (await readBuildFile(build.metadata)).bytes() });
    await expandRows(page, 'global-metadata.dat');
    const chooser = page.waitForEvent('filechooser');
    await findRow(page, 'GameAssembly.dll').click();
    const realBinary = Buffer.from(await (await readBuildFile(build.binary)).bytes());
    await (await chooser).setFiles({ name: 'GameAssembly.dll', mimeType: 'application/octet-stream', buffer: realBinary });
    expect(await readUntil(isBinaryLoaded(page), true)).toBe(true);

    // expands the namespace, whose twistie click puts the focus in the Symbols view, and types the name, which scrolls
    // to the type among the namespace's hundreds of types
    await expandRows(page, 'UnityEngine.CoreModule.dll', 'UnityEngine');
    await page.keyboard.type('Vector3');
    await findRow(page, 'Vector3').click();
    await waitForTabs(page, 'About', 'Vector3.cs');
    // `Vector3.Normalize` calls a function of the binary that isn't a method of the game on line 136
    const callLine = 'sub_18012712c();';
    await readUntil(async () => (await readLines(page)).some(line => line.includes('public struct Vector3')), true);
    await waitForWholeStub(page);
    await page.keyboard.press('Control+G');
    await page.keyboard.insertText('136');
    await page.keyboard.press('Enter');
    expect(await readUntil(async () => (await readLines(page)).some(line => line.includes(callLine)), true)).toBe(true);
    await findWord(page, callLine, 'sub_18012712c').click();
    await page.keyboard.press('F12');

    expect(await readUntil(() => readActiveTab(page), 'sub_18012712c.c')).toBe('sub_18012712c.c');
    expect(await readUntil(async () => (await readLines(page)).some(line => line.includes('sub_18012712c(')), true)).toBe(true);
}, testTimeoutMs * 6);

test("F12 on a function or a global of the binary in a stub's code opens its C or the note of its data", async () => {
    const { page } = await openWorkbench();
    const build = realBuilds['2019.4.34'];
    const [gameMetadata, gameBinary] = [await readBuildFile(build.metadata), await readBuildFile(build.binary)];
    await dropFiles(page, { 'global-metadata.dat': await gameMetadata.bytes(), 'GameAssembly.dll': await gameBinary.bytes() });
    await expandRows(page, 'global-metadata.dat', 'UnityEngine.CoreModule.dll', 'UnityEngine');
    await page.keyboard.type('Vector3');
    await findRow(page, 'Vector3').click();
    await waitForTabs(page, 'About', 'Vector3.cs');
    await readUntil(async () => (await readLines(page)).some(line => line.includes('public struct Vector3')), true);
    await waitForWholeStub(page);

    // counts a text's matches in the stub with the find widget, which leaves the caret at the first match
    const countMatches = async (text: string) => {
        await findTab(page, 'Vector3.cs').click();
        await page.locator('.monaco-editor .view-lines').first().click();
        await page.keyboard.press('Control+F');
        await page.keyboard.press('Control+A');
        await page.keyboard.insertText(text);
        await page.keyboard.press('Enter');
        const count = await page.locator('.find-widget .matchesCount').innerText();
        await page.keyboard.press('Escape');

        return count;
    };
    expect(await readUntil(() => countMatches('still decompiling'), 'No results')).toBe('No results');

    for (const name of ['sub_18012712c', 'data_180974519']) {
        expect(await countMatches(name)).not.toBe('No results');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('F12');
        expect(await readUntil(() => readActiveTab(page), `${name}.c`)).toBe(`${name}.c`);
    }

    expect(await readUntil(async () => (await readLines(page)).some(line => line.includes('holds data, not code.')), true)).toBe(true);
}, testTimeoutMs * 6);
