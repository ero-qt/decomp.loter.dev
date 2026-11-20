import { expect, test } from 'bun:test';
import { matchesFile, maxMagicBytes, readManifest, readStart } from './manifest';

const manifest = {
    id: 'dotnet',
    name: '.NET',
    extensions: ['.dll', '.exe'],
    views: [
        { id: 'csharp', title: 'C#', extension: '.cs', language: 'csharp' },
        { id: 'il', title: 'IL', extension: '.il', language: 'il' },
    ],
};

test('readManifest returns a manifest that follows the rules', () => {
    expect(readManifest(manifest)).toEqual(manifest);
});

test("readManifest returns whether an engine's files depend on each other", () => {
    expect(readManifest({ ...manifest, hasLinkedFiles: true }).hasLinkedFiles).toBe(true);
    expect(readManifest(manifest).hasLinkedFiles).toBeUndefined();
});

test("readManifest returns a memory limit and refuses one that isn't a positive whole number", () => {
    expect(readManifest({ ...manifest, memoryLimitBytes: 1000 }).memoryLimitBytes).toBe(1000);
    expect(readManifest(manifest).memoryLimitBytes).toBeUndefined();
    for (const memoryLimitBytes of [0, -1, 1.5, 2 ** 53, '1000']) {
        expect(() => readManifest({ ...manifest, memoryLimitBytes })).toThrow("memoryLimitBytes isn't a positive whole number");
    }
});

test("readManifest returns a cancel limit and refuses one that isn't a positive whole number", () => {
    expect(readManifest({ ...manifest, cancelLimitMs: 10000 }).cancelLimitMs).toBe(10000);
    expect(readManifest(manifest).cancelLimitMs).toBeUndefined();
    for (const cancelLimitMs of [0, -1, 1.5, 2 ** 53, '1000']) {
        expect(() => readManifest({ ...manifest, cancelLimitMs })).toThrow("cancelLimitMs isn't a positive whole number");
    }
});

test("readManifest returns a priority and refuses one that isn't a whole number", () => {
    expect(readManifest({ ...manifest, priority: -2 }).priority).toBe(-2);
    expect(readManifest(manifest).priority).toBeUndefined();
    for (const priority of [1.5, Number.NaN, '1']) {
        expect(() => readManifest({ ...manifest, priority })).toThrow("priority isn't a whole number");
    }
});

test("readManifest returns the magics and refuses one that isn't 1 to 16 bytes in lowercase hex digits", () => {
    expect(readManifest({ ...manifest, magics: ['4d5a', 'cafebabe'] }).magics).toEqual(['4d5a', 'cafebabe']);
    expect(readManifest(manifest).magics).toBeUndefined();
    for (const magic of ['', '4d5', '4D5A', '0x4d', '00'.repeat(17)]) {
        expect(() => readManifest({ ...manifest, magics: [magic] })).toThrow(`the magic '${magic}' isn't 1 to 16 bytes in lowercase hex digits`);
    }
});

test("readStart reads a file's first 16 bytes", async () => {
    const bytes = [...Array(20).keys()];

    expect(await readStart(new Blob([new Uint8Array(bytes)]))).toEqual(new Uint8Array(bytes.slice(0, maxMagicBytes)));
    expect(await readStart(new Blob([new Uint8Array([1, 2])]))).toEqual(new Uint8Array([1, 2]));
});

test('matchesFile matches an extension without its case at the end of the name or a magic at the start of the bytes', () => {
    const native = readManifest({ ...manifest, magics: ['7f454c46'] });
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2]);

    expect(matchesFile(native, 'SHAPES.DLL', new Uint8Array())).toBe(true);
    expect(matchesFile(native, 'shapes.dll.txt', new Uint8Array())).toBe(false);
    expect(matchesFile(native, 'ls', elf)).toBe(true);
    expect(matchesFile(native, 'ls', elf.subarray(0, 3))).toBe(false);
    expect(matchesFile(native, 'ls', elf.subarray(1))).toBe(false);
});

test("readManifest refuses an engine's id or a view's id with other characters than a-z, 0-9 and -", () => {
    const views = [{ ...manifest.views[0], id: 'c/sharp' }];

    expect(() => readManifest({ ...manifest, id: '../Dotnet' })).toThrow("the id '../Dotnet' has other characters than a-z, 0-9 and -");
    expect(() => readManifest({ ...manifest, views })).toThrow("the id of view 0 'c/sharp' has other characters than a-z, 0-9 and -");
});

test('readManifest refuses an extension without a dot at its start', () => {
    const [csharp] = manifest.views;
    const views = [{ ...csharp, extension: 'cs' }];

    expect(() => readManifest({ ...manifest, extensions: ['dll'] })).toThrow("the extension 'dll' doesn't start with a dot");
    expect(() => readManifest({ ...manifest, views })).toThrow("the extension 'cs' doesn't start with a dot");
});

test('readManifest refuses a manifest without a view', () => {
    expect(() => readManifest({ ...manifest, views: [] })).toThrow("the manifest doesn't have a view");
});

test('readManifest refuses more than 31 views', () => {
    const views = Array.from({ length: 32 }, (_, index) => ({ ...manifest.views[0], id: `view-${index}`, extension: `.v${index}` }));

    expect(() => readManifest({ ...manifest, views: views.slice(0, 31) })).not.toThrow();
    expect(() => readManifest({ ...manifest, views })).toThrow('the manifest has more than 31 views');
});

test('readManifest refuses 2 views with the same id or the same extension', () => {
    const [csharp, il] = manifest.views;

    expect(() => readManifest({ ...manifest, views: [csharp, { ...il, id: 'csharp' }] })).toThrow("2 views have the id 'csharp'");
    expect(() => readManifest({ ...manifest, views: [csharp, { ...il, extension: '.cs' }] })).toThrow("2 views have the extension '.cs'");
});

test('readManifest refuses a value of the wrong type', () => {
    expect(() => readManifest({ ...manifest, name: 3 })).toThrow("the name isn't a string");
    expect(() => readManifest({ ...manifest, views: [{ id: 'csharp' }] })).toThrow("the title of view 0 isn't a string");
    expect(() => readManifest({ ...manifest, hasLinkedFiles: 'yes' })).toThrow("hasLinkedFiles isn't a boolean");
    expect(() => readManifest({ ...manifest, views: 'csharp' })).toThrow("the views isn't a list");
    expect(() => readManifest({ ...manifest, views: ['csharp'] })).toThrow("view 0 isn't an object");
    expect(() => readManifest([])).toThrow("the manifest isn't an object");
    expect(() => readManifest(null)).toThrow("the manifest isn't an object");
});

test("readManifest refuses a key that a manifest or a view doesn't have", () => {
    const views = [{ ...manifest.views[0], lang: 'csharp' }];

    expect(() => readManifest({ ...manifest, hasLinkedFile: true })).toThrow("the manifest has the unknown key 'hasLinkedFile'");
    expect(() => readManifest({ ...manifest, views })).toThrow("view 0 has the unknown key 'lang'");
});
