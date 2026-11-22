import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { failed, ok } from '../../contract/reply';
import type { EngineHandlers } from '../../contract/serve';
import { fetchBytes, importModule, LoadError, loadOnce, refuseLoadErrors } from './loading';

const signal = new AbortController().signal;

test('loadOnce calls the loader again after a rejection and keeps the first load that works', async () => {
    let calls = 0;
    const load = loadOnce(async () => {
        calls++;
        if (calls === 1) {
            throw new LoadError('The chunk failed to load.');
        }

        return calls;
    });

    await expect(load()).rejects.toThrow('The chunk failed to load.');
    expect(await load()).toBe(2);
    expect(await load()).toBe(2);
    expect(calls).toBe(2);
});

test('refuseLoadErrors turns a load error into a failed reply and throws any other error', async () => {
    const handlers = refuseLoadErrors({
        list() {
            throw new LoadError("The native engine couldn't load rizin.mjs: 503 Service Unavailable");
        },
        listStrings() {
            throw new Error('Maximum call stack size exceeded.');
        },
        close: () => ok(undefined),
    } as Partial<EngineHandlers> as EngineHandlers);

    expect(await handlers.list(1, signal)).toEqual(failed("The native engine couldn't load rizin.mjs: 503 Service Unavailable"));
    await expect(handlers.listStrings(1, signal)).rejects.toThrow('Maximum call stack size exceeded.');
    expect(await handlers.close(1, signal)).toEqual(ok(undefined));
});

test('fetchBytes reads a file and throws a load error that names a file that is missing', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'loading-'));
    writeFileSync(join(folder, 'files.txt'), 'x86');

    expect(new TextDecoder().decode(await fetchBytes(pathToFileURL(join(folder, 'files.txt')), 'the file list', 'native'))).toBe('x86');
    const missing = await fetchBytes(pathToFileURL(join(folder, 'missing.txt')), 'sleigh/missing.txt', 'native').catch((error: unknown) => error);

    expect(missing).toBeInstanceOf(LoadError);
    expect((missing as LoadError).message).toStartWith("The native engine couldn't load sleigh/missing.txt: ");
});

test('importModule imports a module and throws a load error that names a module that is missing', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'loading-'));
    writeFileSync(join(folder, 'part.mjs'), 'export const answer = 42;');

    expect(await importModule<{ answer: number }>(pathToFileURL(join(folder, 'part.mjs')).href, 'part.mjs', 'native')).toMatchObject({ answer: 42 });
    await expect(importModule(pathToFileURL(join(folder, 'missing.mjs')).href, 'missing.mjs', 'native')).rejects.toBeInstanceOf(LoadError);
});
