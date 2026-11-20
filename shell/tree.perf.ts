import { expect, test } from 'bun:test';
import { startWorkbench, testTimeoutMs } from './page-testing';
import { dropFiles, expandRows, findRow, readRowTexts } from './tree-testing';

const openWorkbench = startWorkbench();

test('row with 100,000 rows below it expands', async () => {
    const { page } = await openWorkbench();
    const classes = Array.from({ length: 100000 }, (_, index) => ` public class Class${index}\n`);
    page.setDefaultTimeout(4 * testTimeoutMs);

    await dropFiles(page, { 'large.fake': `fake\nnamespace Large\n${classes.join('')}` });
    await expandRows(page, 'large.fake', 'Large');

    expect((await readRowTexts(page)).slice(0, 5)).toEqual(['large.fake', 'Large', 'Class0', 'Class1', 'Class2']);
    expect(await findRow(page, 'Class0').getAttribute('aria-setsize')).toBe('100000');
}, 5 * testTimeoutMs);
