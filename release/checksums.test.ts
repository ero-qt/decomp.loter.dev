import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listChecksums, maxSubjects, parseChecksums } from './checksums';

const htaccess = fileURLToPath(new URL('../host/htaccess', import.meta.url));

let site: string;

beforeEach(() => {
    site = mkdtempSync(join(tmpdir(), 'checksums-'));
});

afterEach(() => rmSync(site, { recursive: true, force: true }));

function hash(text: string | Buffer) {
    return createHash('sha256').update(text).digest('hex');
}

test("checksums list each site file in sha256sum's format by path, with host/htaccess as .htaccess", async () => {
    mkdirSync(join(site, 'engines/java'), { recursive: true });
    writeFileSync(join(site, 'index.html'), 'page');
    writeFileSync(join(site, 'engines/java/worker.js'), 'worker');

    expect(listChecksums(site).split('\n')).toEqual([
        `${hash(await Bun.file(htaccess).bytes())}  .htaccess`,
        `${hash('worker')}  engines/java/worker.js`,
        `${hash('page')}  index.html`,
        '',
    ]);
});

test("checksums take a site folder with a slash at the end and hash host/htaccess over the site's own .htaccess", async () => {
    writeFileSync(join(site, 'index.html'), 'page');
    writeFileSync(join(site, '.htaccess'), 'old');

    expect(listChecksums(`${site}/`).split('\n')).toEqual([
        `${hash(await Bun.file(htaccess).bytes())}  .htaccess`,
        `${hash('page')}  index.html`,
        '',
    ]);
});

test("checksums leave out the site's own checksums file", async () => {
    writeFileSync(join(site, 'index.html'), 'page');
    writeFileSync(join(site, 'checksums.txt'), 'old');

    expect(listChecksums(site)).not.toContain('checksums.txt');
});

test("checksums refuse a site with more files than GitHub's attestation takes", async () => {
    for (let index = 0; index < maxSubjects; index++) {
        writeFileSync(join(site, `${index}.js`), '');
    }

    expect(() => listChecksums(site)).toThrow(`The site has 1025 files, but an attestation takes at most ${maxSubjects}.`);
});

test('parsed checksums map each path to its hash', () => {
    expect(parseChecksums(`${hash('a')}  a.js\n${hash('b')}  engines/b.js\n`)).toEqual(
        new Map([
            ['a.js', hash('a')],
            ['engines/b.js', hash('b')],
        ]),
    );
});

test('parsing refuses a line that sha256sum would not write', () => {
    expect(() => parseChecksums('abc  a.js\n')).toThrow('checksums.txt has a broken line: abc  a.js');
});
