import { beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSubprojects, listVendorSubmodules, type Versions } from './build/sources';

const repoFolder = fileURLToPath(new URL('../../', import.meta.url));
const testFolder = fileURLToPath(new URL('../../artifacts/native-test/sources/', import.meta.url));
const seed = join(testFolder, 'seed');
// keeps the tests' commits the same on every run and away from the user's git settings
const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

let versions: Versions;
let wraps: Record<string, string>;

function git(folder: string, ...args: string[]): string {
    const { exitCode, stdout, stderr } = Bun.spawnSync(['git', ...args], { cwd: folder, env: gitEnvironment });
    if (exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${stderr.toString()}`);
    }

    return stdout.toString().trim();
}

function writeFiles(folder: string, files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(folder, path, '..'), { recursive: true });
        writeFileSync(join(folder, path), text);
    }
}

// makes a repo with the files in 1 commit and returns the commit
function makeRepo(folder: string, files: Record<string, string>): string {
    mkdirSync(folder, { recursive: true });
    git(folder, 'init', '--quiet', '--initial-branch=main');
    writeFiles(folder, files);
    git(folder, 'add', '.');
    git(folder, 'commit', '--quiet', '--message=start');

    return git(folder, 'rev-parse', 'HEAD');
}

// makes a checkout of rizin with a git wrap and a file wrap, whose upstream URLs only the seed can serve
function makeCheckout(name: string): string {
    const folder = join(testFolder, name);
    writeFiles(folder, { '.gitignore': '/subprojects/*/\n', 'meson.build': "project('rizin')\n", ...wraps });

    return folder;
}

// makes a seed like the `rizin/subprojects` folder that a normal fetch fills
beforeAll(() => {
    rmSync(testFolder, { recursive: true, force: true });

    const subprojects = join(seed, 'rizin', 'subprojects');
    const tinyCommit = makeRepo(join(subprojects, 'tiny'), { 'meson.build': "project('tiny')\n" });

    const blob = join(testFolder, 'blob', 'blob-1');
    mkdirSync(blob, { recursive: true });
    writeFileSync(join(blob, 'meson.build'), "project('blob')\n");
    mkdirSync(join(subprojects, 'packagecache'), { recursive: true });
    const tarball = join(subprojects, 'packagecache', 'blob-1.tar.gz');
    Bun.spawnSync(['tar', '-czf', tarball, '-C', join(testFolder, 'blob'), 'blob-1']);
    const blobHash = createHash('sha256').update(readFileSync(tarball)).digest('hex');

    wraps = {
        'subprojects/tiny.wrap': `[wrap-git]\nurl = https://example.invalid/tiny.git\nrevision = ${tinyCommit}\ndepth = 1\n`,
        'subprojects/blob.wrap': [
            '[wrap-file]',
            'directory = blob-1',
            'source_url = https://example.invalid/blob-1.tar.gz',
            'source_filename = blob-1.tar.gz',
            `source_hash = ${blobHash}`,
            '',
        ].join('\n'),
    };
    versions = {
        emscripten: '6.0.9',
        subprojects: [
            { name: 'tiny', directory: 'tiny', url: 'https://example.invalid/tiny.git', commit: tinyCommit },
            { name: 'blob', directory: 'blob-1', url: 'https://example.invalid/blob-1.tar.gz', file: 'blob-1.tar.gz', sha256: blobHash },
        ],
    };
});

test('subprojects come from a seed at the pinned commit without a download', async () => {
    const checkout = makeCheckout('fetched');

    await fetchSubprojects(checkout, { seed, versions });

    expect(git(join(checkout, 'subprojects', 'tiny'), 'rev-parse', 'HEAD')).toBe(versions.subprojects[0].commit!);
    expect(existsSync(join(checkout, 'subprojects', 'blob-1', 'meson.build'))).toBe(true);
}, 60000);

test('fetch stops for a subproject at another commit', async () => {
    const checkout = makeCheckout('moved');
    await fetchSubprojects(checkout, { seed, versions });

    const otherCommit = '0'.repeat(40);
    const [tiny, blob] = versions.subprojects;
    const moved = { ...versions, subprojects: [{ ...tiny, commit: otherCommit }, blob] };
    const tinyFolder = join(checkout, 'subprojects', 'tiny');

    await expect(fetchSubprojects(checkout, { seed, versions: moved })).rejects.toThrow(`${tinyFolder} isn't at commit ${otherCommit}.`);
}, 60000);

test('a changed wrap fetches its subproject again with the new package files', async () => {
    const checkout = makeCheckout('changed');
    await fetchSubprojects(checkout, { seed, versions });

    writeFiles(checkout, { 'subprojects/packagefiles/tiny/extra.txt': 'extra\n' });
    appendFileSync(join(checkout, 'subprojects', 'tiny.wrap'), 'patch_directory = tiny\n');
    await fetchSubprojects(checkout, { seed, versions });

    expect(readFileSync(join(checkout, 'subprojects', 'tiny', 'extra.txt'), 'utf8')).toBe('extra\n');
}, 60000);

test('vendor submodules are the forks of rizin and rz-ghidra with the ghidra and pugixml that rz-ghidra pins', () => {
    const submodules = listVendorSubmodules();

    expect(submodules.map(({ path, url }) => [path, url])).toEqual([
        ['engines/native/vendor/rizin', 'https://github.com/ero-qt/rizin'],
        ['engines/native/vendor/rz-ghidra', 'https://github.com/ero-qt/rz-ghidra'],
        ['engines/native/vendor/rz-ghidra/ghidra/ghidra', 'https://github.com/rizinorg/ghidra.git'],
        ['engines/native/vendor/rz-ghidra/third-party/pugixml', 'https://github.com/zeux/pugixml.git'],
    ]);
    for (const { path, commit } of submodules) {
        // reads the commit that the submodule's parent repo pins, from the entry of the submodule's folder
        const folder = join(repoFolder, path);
        const pinned = git(dirname(folder), 'ls-files', '--stage', '--', basename(folder)).split(/\s/)[1];

        expect(commit).toBe(pinned);
    }
});
