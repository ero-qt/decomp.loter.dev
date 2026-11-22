import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStamped, findTool, requireTool } from './testing';

// builds `out.txt` from `in.txt` in a new folder and counts the builds
function useStampedBuild() {
    const folder = mkdtempSync(join(tmpdir(), 'stamped-'));
    const input = join(folder, 'in.txt');
    let builds = 0;
    writeFileSync(input, 'first');

    async function build(toolVersion?: string) {
        await buildStamped({
            folder: join(folder, 'out'),
            inputs: [input],
            toolVersion,
            outputs: ['out.txt'],
            async build() {
                builds++;
                writeFileSync(join(folder, 'out', 'out.txt'), 'built');
            },
        });

        return builds;
    }

    return { input, build };
}

test('buildStamped skips the build with an equal stamp and rebuilds after an input changes', async () => {
    const { input, build } = useStampedBuild();

    expect(await build('tool 1')).toBe(1);
    expect(await build('tool 1')).toBe(1);

    writeFileSync(input, 'second');

    expect(await build('tool 1')).toBe(2);
});

test("buildStamped rebuilds for another tool's version and keeps any tool's build without a version", async () => {
    const { build } = useStampedBuild();

    expect(await build('tool 1')).toBe(1);
    expect(await build('tool 2')).toBe(2);
    expect(await build()).toBe(2);
});

test('findTool takes the folder of the environment variable before the PATH', () => {
    const folder = mkdtempSync(join(tmpdir(), 'tools-'));
    writeFileSync(join(folder, 'javac'), '', { mode: 0o755 });
    const before = process.env.TESTING_TOOLS;
    process.env.TESTING_TOOLS = folder;

    try {
        expect(findTool(['javac'], 'TESTING_TOOLS')).toBe(join(folder, 'javac'));
        expect(findTool(['no-such-tool'])).toBeUndefined();
    } finally {
        if (before === undefined) {
            delete process.env.TESTING_TOOLS;
        } else {
            process.env.TESTING_TOOLS = before;
        }
    }
});

test('requireTool names the tool and why the tests need it', () => {
    expect(() => requireTool(['no-such-tool'], 'the .NET SDK 11', 'compile assemblies with it')).toThrow(
        'Install the .NET SDK 11 because the tests compile assemblies with it.',
    );
});
