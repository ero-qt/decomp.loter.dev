import { expect, test } from 'bun:test';
import { readRows, type Row } from '#contract/rows';
import { modifiersOf } from '#contract/symbols';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

async function listFile(name: string): Promise<Row[]> {
    const engine = connect();
    const file = await readFixture(name);
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));
    await engine.close(fileId);

    return rows;
}

// writes each class row with its document modifier and the name and detail of each of its methods
function describeClass(rows: Row[], name: string): string[] {
    const index = rows.findIndex(row => row.kind === 'class' && row.name === name);
    const methods = rows.filter(row => row.parent === index).map(row => `${row.kind} ${row.name} ${row.detail}`);

    return [`class ${name} ${modifiersOf(rows[index].flags).join(' ')}`, ...methods];
}

test('shapes-x64-stripped.so lists Shape and Circle with their virtual methods as sub_ rows', async () => {
    const rows = await listFile('shapes-x64-stripped.so');
    const geometry = rows.findIndex(row => row.name === 'geometry');

    expect(rows.filter(row => row.parent === geometry).map(row => `${row.kind} ${row.name}`)).toEqual(['class Circle', 'class Shape']);
    for (const name of ['Circle', 'Shape']) {
        const [classRow, ...methods] = describeClass(rows, name);

        expect(classRow).toBe(`class ${name} document`);
        expect(methods).toHaveLength(2);
        for (const method of methods) {
            expect(method).toMatch(/^method sub_([0-9a-f]+) 0x\1$/);
        }
    }
}, 120000);
