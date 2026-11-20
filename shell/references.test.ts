import { expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { sampleFiles } from '../contract/fake';
import type { WorkerRequest } from '../contract/serve';
import { findWord, openCircle, readActiveTab, readReferences, readUntil, readWarnings, waitForTabs } from './editor-testing';
import { collectErrors, startWorkbench, testTimeoutMs, waitForEngineReplies } from './page-testing';
import { dropAndWait, dropFiles, expandRows, findRow, startWithEngines } from './tree-testing';

const openWorkbench = startWorkbench();
const drawing = await sampleFiles.drawing.text();
const shapes = await sampleFiles.shapes.text();
const squares = `fake
namespace Squares
 public class Square
  public method Draw
   uses shapes.fake|Shapes.Shape.Area
  public method Fill
   uses shapes.fake|Shapes.Shape.Area
`;

/**
 * Serves an engine whose file lists the class `Used` with the key 1 and a class `User<key>` for each user with the keys
 * from 2 up, 60 users or the number in the file's name, like 2 users in `used2.test`. Each class has its own document,
 * except in a file whose name starts with `shared`, where each user but the last user is in the first user's document.
 * `Used`'s document declares and uses the local `count`. Each user's document uses `Used`. The engine keeps each call's
 * method and arguments without the files, or `['cancel']` for a cancel message, in `self.calls`. `findReferences`
 * returns the users of every file that the engine opened, also of a closed file.
 *
 * In a file whose name starts with `outside`, the users' documents give `Used` the target `|<file id>`, which resolves
 * to `Used`. The engine refuses `findReferences` in a file whose name starts with `refusing` and returns a text that
 * isn't a target after the first user in a file whose name starts with `bogus`. The engine replies to `read` of a user
 * after 200 ms in a file whose name starts with `slow` and writes a token past the text's end in the document of the
 * user with the key 3 in a file whose name starts with `crashing`. In a file whose name starts with `placed`, each user
 * comes with the place of its use of `Used`.
 */
function serveUsersEngine() {
    // file's id -> the file's name
    const names = new Map<string, string>();
    const calls: unknown[][] = [];
    Object.assign(self, { calls });

    function listUserKeys(name: string): number[] {
        return Array.from({ length: Number(/\d+/.exec(name)?.[0] ?? 60) }, (_, index) => index + 2);
    }

    function list(name: string) {
        const userKeys = listUserKeys(name);
        const isShared = name.startsWith('shared');
        // the class `Used` and the users, each with the modifier `document` or with the first user as the parent
        const values = new Int32Array([1, ...userKeys].flatMap(key => {
            return isShared && key > 2 && key < userKeys.at(-1)! ? [1, 0, 1, key, 0] : [1, 32, -1, key, 0];
        }));
        const rowNames = ['Used', ...userKeys.map(key => `User${key}`)];

        return { values, names: rowNames, details: rowNames.map(() => ''), note: '', missingFiles: [] };
    }

    function read(fileId: string, name: string, key: number) {
        // line -> the line's token: its word, kind, flags and target, with 16 for the modifier `declaration`
        const usedLines: [line: string, word: string, kind: number, flags: number, target: string][] = [
            ['class Used', 'Used', 1, 16, `${fileId}:1`],
            ['    var count', 'count', 15, 16, 'L:0'],
            ['    use count', 'count', 15, 0, 'L:0'],
        ];
        const userLines: typeof usedLines = [
            [`class User${key}`, `User${key}`, 1, 16, `${fileId}:${key.toString(16)}`],
            ['    use Used', 'Used', 1, 0, name.startsWith('outside') ? `|${fileId}` : `${fileId}:1`],
        ];
        const tokens: number[] = [];
        const targets: string[] = [];
        let text = '';
        for (const [line, word, kind, flags, target] of key === 1 ? usedLines : userLines) {
            targets.push(...(targets.includes(target) ? [] : [target]));
            tokens.push(text.length + line.indexOf(word), word.length, kind, flags, targets.indexOf(target));
            text += `${line}\n`;
        }

        tokens[1] += name.startsWith('crashing') && key === 3 ? 1000 : 0;

        return { text, tokens: new Int32Array(tokens), targets, locals: ['var count'] };
    }

    onmessage = function ({ data }: MessageEvent<WorkerRequest>) {
        // keeps a cancel message and doesn't reply to it because the engine finishes each call
        if ('cancel' in data) {
            calls.push(['cancel']);
            return;
        }

        const { method, args } = data;
        calls.push([method, ...args.filter(arg => !(arg instanceof Blob))]);
        const fileId = String(args[0]).split(':')[0];
        if (method === 'open') {
            names.set(fileId, String(args[1]));
        }

        const name = names.get(fileId) ?? '';
        const users = [...names].flatMap(([id, opened]) => listUserKeys(opened).map(key => `${id}:${key.toString(16)}`));
        const ranges = name.startsWith('placed') ? new Int32Array([1, 8, 4]) : null;
        const references = users.map(user => ({ user, ranges }));
        // method -> the method's reply
        const replies: Record<string, unknown> = {
            claims: { value: true },
            list: { value: list(name) },
            resolve: { value: `${String(args[0]).slice(1)}:1` },
            findReferences: name.startsWith('refusing')
                ? { error: "The engine can't find the references of Used." }
                : { value: name.startsWith('bogus') ? [references[0], { user: 'bogus', ranges }, ...references.slice(1)] : references },
        };
        if (method === 'read') {
            const reply = { value: read(fileId, name, Number(args[1])) };
            setTimeout(() => postMessage({ reply }), name.startsWith('slow') && args[1] !== 1 ? 200 : 0);
        } else {
            postMessage({ reply: replies[method] ?? { value: undefined } });
        }
    };

    postMessage({ ready: true });
}

/**
 * Starts the workbench with the users engine for `.test` files and for `.other` files, drops the other files before the
 * file, expands the file and opens the document of the file's row with the label.
 */
async function openDocument(page: Page, label: string, name: string, ...otherNames: string[]) {
    const usersEngine = { extensions: ['.test'], serve: serveUsersEngine };
    await startWithEngines(page, { others: { ...usersEngine, extensions: ['.other'] }, users: usersEngine });
    await dropAndWait(page, Object.fromEntries([...otherNames, name].map(dropped => [dropped, ''])));
    await expandRows(page, name);
    await findRow(page, label).click();
    await waitForTabs(page, 'About', `${label}.code`);
}

function readCalls(page: Page, engineId = 'users'): Promise<unknown[][]> {
    const worker = page.workers().find(worker => worker.url().includes(`/engines/${engineId}/`))!;

    return worker.evaluate(() => (self as unknown as { calls: unknown[][] }).calls);
}

async function countUserReads(page: Page, engineId?: string): Promise<number> {
    return (await readCalls(page, engineId)).filter(([method, , key]) => method === 'read' && key !== 1).length;
}

test('Shift+F12 on `Area` lists its use in `Circle.code` and its declaration in `Shape.code`', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'shapes.fake': shapes });
    await openCircle(page, drawing, 'Draw');

    await findWord(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Shape.code 1', 'Circle.code 1', 'uses Shapes.Shape.Area'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
}, testTimeoutMs);

test('Shift+F12 lists the uses in the documents of users in 2 files and reads a document with 2 users once', async () => {
    const { page } = await openWorkbench();
    await dropAndWait(page, { 'shapes.fake': shapes, 'squares.fake': squares });
    await openCircle(page, drawing, 'Draw');

    await findWord(page, 'uses Shapes.Shape.Area', 'Shapes.Shape.Area').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Shape.code 1', 'Square.code 2', 'Circle.code 1', 'uses Shapes.Shape.Area'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
}, testTimeoutMs);

test("Shift+F12 lists the uses at the engine's places without reading the users' documents", async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'placed2.test');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Used.code 1', 'class Used', 'User2.code 1', 'User3.code 1'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
    expect(await countUserReads(page)).toBe(0);
}, testTimeoutMs);

test("Shift+F12 opens a use at the engine's line and character", async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'placed2.test');
    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');
    const rows = page.locator('.reference-zone-widget .ref-tree .monaco-list-row');
    await rows.filter({ hasText: 'User2.code' }).click();

    await rows.filter({ hasText: 'use Used' }).dblclick();

    expect(await readUntil(() => readActiveTab(page), 'User2.code')).toBe('User2.code');
    // reads the status bar's whole cursor item because the workbench selects the use, from character 8 to the cursor at
    // its end
    const readSelection = async () => (await page.locator('.statusbar-item').allTextContents()).find(item => item.startsWith('Ln '));
    expect(await readUntil(readSelection, 'Ln 2, Col 13 (4 selected)')).toBe('Ln 2, Col 13 (4 selected)');
}, testTimeoutMs);

test('Shift+F12 lists a use in the ops document of a user whose document the first view hides', async () => {
    const { page } = await openWorkbench();
    const box = 'fake\nclass Box\n public method Get\nhidden class Secret\n public method Peek\n  uses box.fake|Box.Get\n';
    await dropFiles(page, { 'box.fake': box });
    await expandRows(page, 'box.fake', 'Box');
    await findRow(page, 'Get').click();
    await waitForTabs(page, 'About', 'Box.code');

    await findWord(page, 'method Get', 'Get').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Box.code 1', 'public method Get', 'Secret.ops 1'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
}, testTimeoutMs);

test("Shift+F12 on a local lists the local's declaration and use in its document without reading a user", async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'used.test');

    await findWord(page, 'use count', 'count').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['var count', 'use count'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
    expect(await countUserReads(page)).toBe(0);
}, testTimeoutMs);

test('Shift+F12 on a symbol with 60 users reads the documents of the first 50 users', async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'used.test');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');
    await readReferences(page);

    expect(await countUserReads(page)).toBe(50);
}, testTimeoutMs);

test('Shift+F12 on a symbol with 60 users shows a warning that the references come from the first 50 documents', async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'used.test');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Showing references from the first 50 documents.'];
    expect(await readWarnings(page, ...expected)).toEqual(expected);
}, testTimeoutMs);

test('Shift+F12 on a symbol with 50 users shows no warning', async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'used50.test');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');
    await readReferences(page);

    expect(await page.locator('.notification-toast').count()).toBe(0);
}, testTimeoutMs);

test("cursor move during Shift+F12 stops the reads of further users and cancels the running user's read", async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'slow.test');
    await findWord(page, 'class Used', 'Used').click();

    await page.keyboard.press('Shift+F12');
    expect(await readUntil(async () => Math.min(await countUserReads(page), 2), 2)).toBe(2);
    await page.keyboard.press('ArrowDown');
    // waits for the read that started before the move because the search stops only between users. A search that goes
    // on sends the next user's read in the task of the last reply, so the page then never has a reply for each read.
    await waitForEngineReplies(page, 'read');

    expect(await countUserReads(page)).toBeLessThan(10);
    expect(await readCalls(page)).toContainEqual(['cancel']);
}, testTimeoutMs);

test("Shift+F12 on a symbol whose `findReferences` call the engine refuses doesn't find references and doesn't log an error", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await openDocument(page, 'Used', 'refusing.test');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    await page.locator('.monaco-editor-overlaymessage').filter({ hasText: "No references found for 'Used'" }).waitFor();
    expect(errors).toEqual([]);
}, testTimeoutMs);

test('Shift+F12 on a symbol with 1 user lists the use and the declaration after 1 `findReferences` call', async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'used1.test');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Used.code 1', 'class Used', 'User2.code 1'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
    expect((await readCalls(page)).filter(([method]) => method === 'findReferences')).toHaveLength(1);
}, testTimeoutMs);

test('Shift+F12 on a use whose target resolves to a row lists the uses with the same target in both users', async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'User2', 'outside2.test');

    await findWord(page, 'use Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Used.code 1', 'User2.code 1', 'use Used', 'User3.code 1'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
}, testTimeoutMs);

test("Shift+F12 after a closed peek reads the users' documents again", async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'used2.test');
    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');
    await readReferences(page);
    await page.keyboard.press('Escape');
    await page.locator('.reference-zone-widget').waitFor({ state: 'hidden' });

    await page.keyboard.press('Shift+F12');
    await readReferences(page);

    expect(await countUserReads(page)).toBe(4);
}, testTimeoutMs);

test("Shift+F12 on a symbol whose first 50 users share a document lists the use in the 51st user's document", async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'shared51.test');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Used.code 1', 'class Used', 'User2.code 1', 'User52.code 1'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
}, testTimeoutMs);

test("Shift+F12 lists the other users' uses after a user's document crashes and logs the crash once", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await openDocument(page, 'Used', 'crashing2.test');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Used.code 1', 'class Used', 'User2.code 1'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
    expect(errors).toHaveLength(1);
}, testTimeoutMs);

test("Shift+F12 doesn't find references for a reply with a user that isn't a target and logs 1 error", async () => {
    const { page } = await openWorkbench();
    const errors = collectErrors(page);
    await openDocument(page, 'Used', 'bogus2.test');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    await page.locator('.monaco-editor-overlaymessage').filter({ hasText: "No references found for 'Used'" }).waitFor();
    expect(errors).toHaveLength(1);
}, testTimeoutMs);

test("Shift+F12 doesn't read the documents of another engine's file with the same file id", async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'used2.test', 'other2.other');

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Used.code 1', 'class Used', 'User2.code 1', 'User3.code 1'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
    expect(await countUserReads(page, 'others')).toBe(0);
}, testTimeoutMs);

test('Shift+F12 leaves out the users in a closed file', async () => {
    const { page } = await openWorkbench();
    await openDocument(page, 'Used', 'used2.test', 'gone2.test');
    await findRow(page, 'gone2.test').click();
    await page.keyboard.press('Delete');
    await findRow(page, 'gone2.test').waitFor({ state: 'detached' });

    await findWord(page, 'class Used', 'Used').click();
    await page.keyboard.press('Shift+F12');

    const expected = ['Used.code 1', 'class Used', 'User2.code 1', 'User3.code 1'];
    expect(await readUntil(() => readReferences(page), expected)).toEqual(expected);
    expect((await readCalls(page)).filter(([method, fileId]) => method === 'read' && fileId === 1)).toEqual([]);
}, testTimeoutMs);
