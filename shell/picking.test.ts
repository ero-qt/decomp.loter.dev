import { expect, test } from 'bun:test';
import { formatUnopenedText, type PickedFile } from './picking';

function pick(...paths: string[]): PickedFile[] {
    return paths.map(path => ({ path, file: new File([''], path.split('/').at(-1)!) }));
}

test("formatUnopenedText names a picked file that didn't open", () => {
    const picked = pick('drawing.fake', 'notes.txt');

    expect(formatUnopenedText(picked, picked.slice(1))).toBe("No engine opens 'notes.txt'.");
});

test("formatUnopenedText names each picked file that didn't open in 1 text", () => {
    expect(formatUnopenedText(pick('a.txt', 'b.txt'), pick('a.txt', 'b.txt'))).toBe("No engine opens 'a.txt' or 'b.txt'.");
});

test("formatUnopenedText names 3 files and counts the other files when more than 4 files didn't open", () => {
    const picked = pick('a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt');

    expect(formatUnopenedText(picked, picked)).toBe("No engine opens 'a.txt', 'b.txt', 'c.txt', or 2 other files.");
});

test('formatUnopenedText returns undefined when each picked file opened', () => {
    expect(formatUnopenedText(pick('drawing.fake'), [])).toBeUndefined();
});

test("formatUnopenedText leaves out a folder's files when another file of the folder opened", () => {
    const picked = pick('bin/drawing.fake', 'bin/readme.txt');

    expect(formatUnopenedText(picked, picked.slice(1))).toBeUndefined();
});

test("formatUnopenedText tells that no file in the folder opens when none of the folder's files opened", () => {
    const picked = pick('bin/readme.txt', 'bin/lib/notes.txt');

    expect(formatUnopenedText(picked, picked)).toBe('No file in the folder can be opened.');
});
