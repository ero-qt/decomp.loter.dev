import { expect, test } from 'bun:test';
import { EngineError, failed } from '#contract/reply';
import { createJavaHandlers } from './handlers';
import { classFile, useJavaEngine, zipFile } from './testing';

const connect = useJavaEngine();
const manifestEntry = { name: 'META-INF/MANIFEST.MF', bytes: new TextEncoder().encode('Manifest-Version: 1.0\n') };

test('java engine opens a class file alone and claims it under any name by its start', async () => {
    const engine = connect();
    const bytes = classFile({ name: 'a/B' });

    expect(await engine.claims('data.bin', new File([bytes], 'data.bin'))).toBe(true);
    await engine.close(await engine.open('B.class', new File([bytes], 'B.class')));
});

test('java engine claims a zip file without a JAR extension only when it has a class entry', async () => {
    const engine = connect();
    const document = zipFile([manifestEntry, { name: 'word/document.xml', bytes: manifestEntry.bytes }]);
    const app = zipFile([manifestEntry, { name: 'a/B.class', bytes: classFile({ name: 'a/B' }) }]);

    expect(await engine.claims('report.docx', new File([document], 'report.docx'))).toBe(false);
    expect(await engine.claims('app.zip', new File([app], 'app.zip'))).toBe(true);
});

test('java engine claims and opens a JAR after a launch script', async () => {
    const engine = connect();
    const jar = zipFile([manifestEntry, { name: 'a/B.class', bytes: classFile({ name: 'a/B' }) }]);
    const launchable = new File(['#!/bin/bash\nexec java -jar "$0" "$@"\n', jar], 'app.jar');

    expect(await engine.claims(launchable.name, launchable)).toBe(true);
    await engine.close(await engine.open(launchable.name, launchable));
});

test('java engine refuses a truncated class file and a text file named like a JAR', async () => {
    const engine = connect();
    const truncated = new File([classFile({ name: 'a/B' }).subarray(0, 20)], 'B.class');
    const text = new File(['some notes'], 'notes.jar');

    expect(await engine.claims(truncated.name, truncated)).toBe(true);
    await expect(engine.open(truncated.name, truncated)).rejects.toBeInstanceOf(EngineError);
    await expect(engine.open(truncated.name, truncated)).rejects.toThrow("The engine can't read B.class: ");
    await expect(engine.open(text.name, text)).rejects.toThrow("notes.jar: The file isn't a zip file.");
});

test('java engine refuses a JAR without a class file and counts what it leaves out', async () => {
    const engine = connect();
    const nested = new File([zipFile([manifestEntry, { name: 'lib/a.jar', bytes: new Uint8Array() }])], 'app.jar');
    const empty = new File([zipFile([manifestEntry])], 'empty.jar');

    await expect(engine.open(nested.name, nested)).rejects.toThrow('app.jar: 1 nested JAR not shown');
    await expect(engine.open(empty.name, empty)).rejects.toThrow("empty.jar doesn't have a class file.");
});

test('java engine opens classes that contain each other in a loop', async () => {
    const engine = connect();
    const jar = zipFile([
        { name: 'a/A.class', bytes: classFile({ name: 'a/A', innerClasses: [{ inner: 'a/A', outer: 'a/B', simpleName: 'A' }] }) },
        { name: 'a/B.class', bytes: classFile({ name: 'a/B', innerClasses: [{ inner: 'a/B', outer: 'a/A', simpleName: 'B' }] }) },
    ]);

    await engine.close(await engine.open('loop.jar', new File([jar], 'loop.jar')));
});

test("java engine refuses an archive over 512 MB before it reads the archive and one whose bytes don't fit in memory", async () => {
    const handlers = createJavaHandlers();
    const signal = new AbortController().signal;
    const huge = { size: 512 * 1024 * 1024 + 1, bytes: () => Promise.reject(new Error('The engine read the archive.')) } as unknown as Blob;
    const unfit = { size: 1000, bytes: () => Promise.reject(new RangeError('Array buffer allocation failed')) } as unknown as Blob;

    expect(await handlers.open(1, 'huge.war', huge, signal)).toEqual(failed("huge.war has more than 512 MB, which the engine can't open."));
    expect(await handlers.open(2, 'app.war', unfit, signal)).toEqual(failed("app.war doesn't fit in the engine's memory."));
});
