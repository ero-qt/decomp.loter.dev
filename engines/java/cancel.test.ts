import { expect, test } from 'bun:test';
import { createJavaHandlers } from './handlers';
import { classFile, zipFile } from './testing';

const jar = new File([zipFile([{ name: 'a/B.class', bytes: classFile({ name: 'a/B' }) }])], 'app.jar');

test('java engine stops an open, a search for users and a listing of strings once its signal aborts', async () => {
    const handlers = createJavaHandlers();
    await handlers.open(1, jar.name, jar, new AbortController().signal);

    await expect(handlers.open(2, jar.name, jar, AbortSignal.abort())).rejects.toThrow('aborted');
    await expect(handlers.findReferences('1:0', 'java', AbortSignal.abort())).rejects.toThrow('aborted');
    await expect(handlers.listStrings(1, AbortSignal.abort())).rejects.toThrow('aborted');
});
