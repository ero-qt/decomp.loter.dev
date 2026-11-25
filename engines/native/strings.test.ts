import { expect, test } from 'bun:test';
import { formatTarget } from '#contract/document';
import type { StringUse } from '#contract/engine';
import { readRows } from '#contract/rows';
import type { NativeModule } from './module';
import { groupRows } from './rows';
import { listStrings } from './strings';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

// opens a fixture's file and returns its strings with the target of the row whose name is `user`
async function listFileStrings(name: string, user: string): Promise<{ strings: StringUse[]; user: string }> {
    const engine = connect();
    const file = await readFixture(name);
    const fileId = await engine.open(file.name, file);
    const rows = readRows(await engine.list(fileId));

    return { strings: await engine.listStrings(fileId), user: formatTarget({ fileId, key: rows.find(row => row.name === user)!.key }) };
}

test("strings include the fixture's string with the function that uses it", async () => {
    const { strings, user } = await listFileStrings('shapes-x64.so', 'fixture_name');

    expect(strings).toContainEqual({ text: 'shapes fixture', user });
}, 120000);

test('strings of a file at a high image base have their users', async () => {
    const { strings, user } = await listFileStrings('extras-high.so', 'extras_name');

    expect(strings).toContainEqual({ text: 'extras fixture', user });
}, 120000);

test('strings stop at 50,000 and each string at 1,000 characters with a mark', async () => {
    const asked: number[] = [];
    const module = {
        listStrings(_: number, maxStrings: number) {
            asked.push(maxStrings);

            return Array.from({ length: maxStrings }, (_, index) => ({ addr: `0x${index.toString(16)}`, text: `${index}`.padEnd(1200, '.') }));
        },
        listReferences: () => [],
    } as unknown as NativeModule;
    const strings = await listStrings(module, 1, 2, () => undefined, new AbortController().signal);

    expect(asked).toEqual([50000]);
    expect(strings).toHaveLength(50000);
    expect(strings[1]).toEqual({ text: `1${'.'.repeat(998)}…`, user: null });
});

test('a canceled listing of strings stops', async () => {
    const module = {
        listStrings: () => Array.from({ length: 10000 }, (_, index) => ({ addr: `0x${index.toString(16)}`, text: 'text' })),
        listReferences: () => [],
    } as unknown as NativeModule;

    await expect(listStrings(module, 1, 2, () => undefined, AbortSignal.abort())).rejects.toThrow();
});

test('the note counts the strings above 50,000', () => {
    const listing = {
        base: '0x0',
        functions: [],
        data: [],
        imports: [],
        types: [],
        classes: [],
        pdb: '',
        hasPdb: false,
        omitted: 0,
        omittedImports: 0,
    };

    expect(groupRows({ ...listing, strings: 50000 }).note).toBe('');
    expect(groupRows({ ...listing, strings: 60000 }).note).toBe('Lists 50,000 of 60,000 strings.');
});
