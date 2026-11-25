import { Glob } from 'bun';
import { expect, test } from 'bun:test';

test('only workbench.ts and workbench-common.ts import names from inside the workbench', async () => {
    const folder = new URL('.', import.meta.url).pathname;
    // writes the path in 2 parts because this file's own text would otherwise have the import
    const inside = new RegExp(`from '@codingame/monaco-vscode-api/${'vscode/vs'}/`);
    const paths: string[] = [];
    for await (const path of new Glob('*.ts').scan(folder)) {
        if (!path.startsWith('workbench') && inside.test(await Bun.file(`${folder}${path}`).text())) {
            paths.push(path);
        }
    }

    expect(paths).toEqual([]);
});
