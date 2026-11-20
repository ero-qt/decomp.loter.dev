import { expect, test } from 'bun:test';
import { zipFile } from './testing';
import { findClassEntry, maxEntryBytes, maxFileBytes, openZip } from './zip';

const megabyte = 1024 * 1024;
const manifest = new TextEncoder().encode('Manifest-Version: 1.0\r\n');
const classBytes = Uint8Array.from({ length: 3000 }, (_, index) => (index * 7) % 256);
// the start of a Spring Boot JAR that runs as a program
const launchScript = '#!/bin/bash\nexec java -jar "$0" "$@"\n';

// returns the message of the error that a call throws or rejects with, or `null` when it doesn't fail
async function readError(call: () => unknown): Promise<string | null> {
    try {
        await call();
    } catch (error) {
        return (error as Error).message;
    }

    return null;
}

test('openZip lists the entries of a JAR and reads each stored or deflated entry', async () => {
    const jar = openZip(zipFile([
        { name: 'META-INF/MANIFEST.MF', bytes: manifest, stored: true },
        { name: 'a/B.class', bytes: classBytes },
        { name: 'a/Ünïcode$1.class', bytes: new Uint8Array() },
    ]));

    expect(jar.names).toEqual(['META-INF/MANIFEST.MF', 'a/B.class', 'a/Ünïcode$1.class']);
    expect(await jar.read('META-INF/MANIFEST.MF')).toEqual(manifest);
    expect(await jar.read('a/B.class')).toEqual(classBytes);
    expect(await jar.read('a/Ünïcode$1.class')).toEqual(new Uint8Array());
    expect(await jar.read('a/C.class')).toBeNull();
});

test('openZip and findClassEntry read a JAR after a launch script, whose offsets count from the zip data', async () => {
    const jar = zipFile([{ name: 'a/B.class', bytes: classBytes }]);
    const launchable = new Uint8Array(await new Blob([launchScript, jar]).arrayBuffer());

    expect(await openZip(launchable).read('a/B.class')).toEqual(classBytes);
    expect(await findClassEntry(new Blob([launchable]))).toBe(true);
});

test("openZip throws for a file that isn't a zip file and for a zip64 file", async () => {
    const zip64 = zipFile(Array.from({ length: 0xffff }, (_, index) => ({ name: `${index}`, bytes: new Uint8Array(), stored: true })));

    expect(await readError(() => openZip(new Uint8Array()))).toBe("The file isn't a zip file.");
    expect(await readError(() => openZip(classBytes))).toBe("The file isn't a zip file.");
    expect(await readError(() => openZip(zip64))).toBe("The file is a zip64 file, which the engine can't read.");
});

test('openZip throws for a central directory past the end of the file', async () => {
    const bytes = zipFile([{ name: 'a/B.class', bytes: classBytes }]);
    const directoryStart = new DataView(bytes.buffer).getUint32(bytes.length - 6, true);

    expect(await readError(() => openZip(bytes.subarray(directoryStart - 10)))).toBe('The zip file is damaged.');
});

test('openZip throws for a name in the central directory that runs past the end of the file', async () => {
    const bytes = zipFile([{ name: 'a/B.class', bytes: classBytes }]);
    const view = new DataView(bytes.buffer);
    view.setUint16(view.getUint32(bytes.length - 6, true) + 28, 0xfff0, true);

    expect(await readError(() => openZip(bytes))).toBe('The zip file is damaged.');
});

test('read rejects an encrypted entry, an unknown method and damaged data', async () => {
    const jar = openZip(zipFile([
        { name: 'encrypted', bytes: classBytes, flags: 1 },
        { name: 'bzip2', bytes: classBytes, method: 12 },
        { name: 'short', bytes: classBytes, size: classBytes.length + 1 },
        { name: 'garbage', bytes: classBytes, stored: true, method: 8 },
    ]));

    expect(await readError(() => jar.read('encrypted'))).toBe('encrypted is encrypted.');
    expect(await readError(() => jar.read('bzip2'))).toBe("bzip2 uses the compression method 12, which the engine can't read.");
    expect(await readError(() => jar.read('short'))).toBe('The zip file is damaged.');
    expect(await readError(() => jar.read('garbage'))).toBe('The zip file is damaged.');
});

test('read stops an entry that inflates to more than its size or than the limit', async () => {
    const zeros = new Uint8Array(50 * megabyte);
    const jar = openZip(zipFile([
        { name: 'bomb', bytes: zeros },
        { name: 'lying bomb', bytes: zeros, size: 1000 },
    ]));

    expect(await readError(() => jar.read('bomb'))).toBe(`bomb has more than ${maxEntryBytes / megabyte} MB.`);
    expect(await readError(() => jar.read('lying bomb'))).toBe('The zip file is damaged.');
});

test('read stops the entries of a file that inflate to more than the limit of the file in all', async () => {
    const count = maxFileBytes / maxEntryBytes + 1;
    const jar = openZip(zipFile(Array.from({ length: count }, (_, index) => ({ name: `${index}`, bytes: classBytes, size: maxEntryBytes }))));
    const errors: (string | null)[] = [];
    for (let index = 0; index < count; index++) {
        errors.push(await readError(() => jar.read(`${index}`)));
    }

    expect(errors.at(-2)).toBe('The zip file is damaged.');
    expect(errors.at(-1)).toBe(`The entries of the zip file have more than ${maxFileBytes / megabyte} MB.`);
});

test('findClassEntry finds a class entry in a zip file with a comment and data before the central directory', async () => {
    const bytes = zipFile([
        { name: 'META-INF/MANIFEST.MF', bytes: manifest },
        { name: 'a/B.class', bytes: classBytes },
    ]);
    const end = new DataView(bytes.buffer, bytes.length - 22);
    end.setUint16(20, 5, true);
    const commented = new Blob([bytes, 'notes']);

    expect(await findClassEntry(commented)).toBe(true);
});

test("findClassEntry returns false for a zip file without a class entry and for a file that isn't a zip file", async () => {
    const document = zipFile([{ name: 'word/document.xml', bytes: manifest }, { name: 'a.class/readme', bytes: manifest }]);
    const damaged = zipFile([{ name: 'a/B.class', bytes: classBytes }]);
    new DataView(damaged.buffer).setUint32(damaged.length - 6, damaged.length, true);

    expect(await findClassEntry(new Blob([document]))).toBe(false);
    expect(await findClassEntry(new Blob([classBytes]))).toBe(false);
    expect(await findClassEntry(new Blob([damaged]))).toBe(false);
});
