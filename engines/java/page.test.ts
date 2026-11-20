import { expect, test } from 'bun:test';
import { readLines, readUntil, readWordColor, waitForTabs } from '../../shell/editor-testing';
import { listOtherHostRequests, startWorkbench, testTimeoutMs } from '../../shell/page-testing';
import { dropFiles, expandRows, findRow, readRowIcon } from '../../shell/tree-testing';
import { fixture } from './fixture';

const openWorkbench = startWorkbench();
const drawing = await fixture.file.bytes();
// the start of the class codicon's path, which the icon of a class's row draws
const classIconPath = 'M13.2069 10.4999';

test("dropped JAR lists its packages and classes, and a click on a class opens the class's Java with the theme's class color", async () => {
    const { page, violations, requests } = await openWorkbench();

    await dropFiles(page, { 'drawing.jar': drawing });
    await expandRows(page, 'drawing.jar', 'drawing');
    await findRow(page, 'Main').click();
    await waitForTabs(page, 'About', 'Main.java');

    expect(await readRowIcon(page, 'Main')).toContain(classIconPath);
    expect(await readUntil(async () => (await readLines(page)).includes('public final class Main {'), true)).toBe(true);
    expect(await readUntil(() => readWordColor(page, 'public final class Main {', 'Main'), '#56c9a2')).toBe('#56c9a2');
    expect(violations).toEqual([]);
    expect(listOtherHostRequests(page, requests)).toEqual([]);
}, testTimeoutMs);
