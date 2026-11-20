import { expect, test } from 'bun:test';
import { Glob } from 'bun';

// matches an import or export from the parent folder, an import of a file there for its effects and a dynamic import of
// one
function importsOutside(code: string): boolean {
    return /^(import|export) [^;]* from '\.\.\/|^import '\.\.\/|\bimport\('\.\.\//m.test(code);
}

test('importsOutside finds each way to load a file outside the folder', () => {
    // writes the parent folder through a variable because this file's own text would otherwise import from outside
    const up = '..';
    const outside = [
        `import { a } from '${up}/x';`,
        `export { a } from '${up}/x';`,
        `export * from '${up}/x';`,
        `import '${up}/x';`,
        `const x = await import('${up}/x');`,
    ];

    expect(outside.filter(importsOutside)).toEqual(outside);
    expect(importsOutside("import { a } from './x';\nexport * from './y';\nimport('./z');")).toBe(false);
});

test('contract imports no file outside its folder', async () => {
    const folder = new URL('.', import.meta.url).pathname;
    const outsidePaths: string[] = [];
    for await (const path of new Glob('*.ts').scan(folder)) {
        if (importsOutside(await Bun.file(`${folder}${path}`).text())) {
            outsidePaths.push(path);
        }
    }

    expect(outsidePaths).toEqual([]);
});
