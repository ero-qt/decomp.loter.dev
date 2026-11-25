import { expect, setDefaultTimeout, test } from 'bun:test';
import { findRow } from '#contract/checking';
import { formatTarget } from '#contract/document';
import type { Engine, StringUse } from '#contract/engine';
import { readRows } from '#contract/rows';
import { fixture } from './fixture';
import { classFile, useJavaEngine } from './testing';

const connect = useJavaEngine();
setDefaultTimeout(60000);

async function openStrings(engine: Engine, file: File): Promise<{ strings: StringUse[]; targetOf(path: string): string }> {
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));

    return { strings: await engine.listStrings(fileId), targetOf: path => formatTarget({ fileId, key: findRow(rows, path, file.name).key }) };
}

test('java engine lists the strings of methods and constants with the row of their member', async () => {
    const { strings, targetOf } = await openStrings(connect(), fixture.file);

    expect(strings).toContainEqual({ text: 'héllo ✓', user: targetOf('drawing.Main.GREETING') });
    expect(strings).toContainEqual({ text: 'large', user: targetOf('drawing.Main.classify') });
    expect(strings).toContainEqual({ text: 'negative radius', user: targetOf('drawing.Circle.Circle') });
});

test("java engine lists the constant parts of a string concatenation's recipe", async () => {
    const { strings, targetOf } = await openStrings(connect(), fixture.file);
    const describe = targetOf('drawing.Main.describe');

    expect(strings).toContainEqual({ text: 'circle of ', user: describe });
    expect(strings).toContainEqual({ text: ' cm', user: describe });
});

test("java engine doesn't list the component names that a record's methods get", async () => {
    const { strings } = await openStrings(connect(), fixture.file);

    expect(strings.map(listed => listed.text)).not.toContain('radius');
});

test('java engine lists a string with a character outside the BMP and cuts a long string at 1,000 characters with a mark', async () => {
    const fields = [
        { name: 'SMILE', descriptor: 'Ljava/lang/String;', value: 'smile 😀' },
        { name: 'LONG', descriptor: 'Ljava/lang/String;', value: 'x'.repeat(1500) },
        { name: 'SPLIT', descriptor: 'Ljava/lang/String;', value: `${'x'.repeat(998)}😀${'x'.repeat(500)}` },
    ];
    const file = new File([classFile({ name: 'a/B', fields })], 'B.class');
    const { strings, targetOf } = await openStrings(connect(), file);

    expect(strings).toEqual([
        { text: 'smile 😀', user: targetOf('a.B.SMILE') },
        { text: `${'x'.repeat(999)}…`, user: targetOf('a.B.LONG') },
        { text: `${'x'.repeat(998)}…`, user: targetOf('a.B.SPLIT') },
    ]);
});

test("java engine doesn't list an empty string", async () => {
    const fields = [{ name: 'EMPTY', descriptor: 'Ljava/lang/String;', value: '' }];
    const { strings } = await openStrings(connect(), new File([classFile({ name: 'a/B', fields })], 'B.class'));

    expect(strings).toEqual([]);
});
