import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const glueFolder = fileURLToPath(new URL('src/', import.meta.url));
const glueFiles = readdirSync(glueFolder).filter(name => /\.[ch]$/.test(name)).sort();

// finds clang-format in NATIVE_LLVM's folder or in Emscripten's LLVM, else on the PATH
function findClangFormat(): string | undefined {
    const llvm = process.env.NATIVE_LLVM;
    if (llvm && existsSync(join(llvm, 'clang-format'))) {
        return join(llvm, 'clang-format');
    }

    const emConfig = Bun.which('em-config');
    const root = emConfig ? Bun.spawnSync([emConfig, 'LLVM_ROOT']).stdout.toString().trim() : '';

    return root && existsSync(join(root, 'clang-format')) ? join(root, 'clang-format') : (Bun.which('clang-format') ?? undefined);
}

test('c files stay within 150 columns', () => {
    const wideLines: string[] = [];
    for (const name of glueFiles) {
        readFileSync(join(glueFolder, name), 'utf8').split('\n').forEach((line, index) => {
            const width = line.replace(/\t/g, ' '.repeat(8)).length;
            const isComment = /^\s*(\/\/|\/\*|\*)/.test(line);
            if (width > (isComment ? 120 : 150)) {
                wideLines.push(`${name}:${index + 1}`);
            }
        });
    }

    expect(glueFiles.length).toBeGreaterThan(0);
    expect(wideLines).toEqual([]);
});

// only checks the format where clang-format is there, because the build doesn't need it
test.skipIf(findClangFormat() === undefined)("c files keep Rizin's clang-format style", () => {
    const command = [findClangFormat()!, '--dry-run', '-Werror', ...glueFiles];
    const { exitCode, stderr } = Bun.spawnSync(command, { cwd: glueFolder });

    expect(stderr.toString()).toBe('');
    expect(exitCode).toBe(0);
});
