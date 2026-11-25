import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('check-imports.ts', import.meta.url).pathname;
const sorted = "import { a } from './a';\nimport { type B, c } from './b';\n\nexport const value: B = a + c;\n";
const unsorted = "import { c, type B } from './b';\nimport { a } from './a';\n\nexport const value: B = a + c;\n";
// imports a file for its effects after another one, which sorted imports would turn around
const effects = "import './b';\nimport { a } from './a';\n\nexport const value = a;\n";

let folder: string;

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'check-imports-'));
    writeFileSync(join(folder, 'tsconfig.json'), '{ "compilerOptions": { "noLib": true, "module": "esnext" }, "include": ["*.ts"] }');
    writeFileSync(join(folder, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(folder, 'b.ts'), 'export const c = 2;\nexport type B = number;\n');
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

function check(...args: string[]) {
    const { exitCode, stderr } = Bun.spawnSync([process.execPath, script, ...args, folder]);

    return { exitCode, error: stderr.toString() };
}

test('the check passes sorted imports and a file that imports for effects', () => {
    writeFileSync(join(folder, 'sorted.ts'), sorted);
    writeFileSync(join(folder, 'effects.ts'), effects);

    expect(check()).toEqual({ exitCode: 0, error: '' });
});

test('the check fails with the path of a file whose imports are out of order and leaves the file alone', () => {
    writeFileSync(join(folder, 'sorted.ts'), sorted);
    writeFileSync(join(folder, 'unsorted.ts'), unsorted);

    const { exitCode, error } = check();

    expect(exitCode).toBe(1);
    expect(error.trimEnd().split('\n').slice(1)).toEqual(['unsorted.ts']);
    expect(readFileSync(join(folder, 'unsorted.ts'), 'utf8')).toBe(unsorted);
});

test('--fix sorts the imports and their names, but not the imports of a file that imports for effects', () => {
    writeFileSync(join(folder, 'unsorted.ts'), unsorted);
    writeFileSync(join(folder, 'effects.ts'), effects);

    expect(check('--fix').exitCode).toBe(0);
    expect(readFileSync(join(folder, 'unsorted.ts'), 'utf8')).toBe(sorted);
    expect(readFileSync(join(folder, 'effects.ts'), 'utf8')).toBe(effects);
    expect(check().exitCode).toBe(0);
});
