import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('deploy.sh', import.meta.url).pathname;
const htaccess = new URL('../host/htaccess', import.meta.url).pathname;

let folder: string;
let site: string;

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'deploy-'));
    site = join(folder, 'site');
    mkdirSync(site);
    writeFileSync(join(site, 'index.html'), '');
    stubCommand('rsync', 0);
    stubCommand('ssh', 0);
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

// writes a command that appends its name and arguments, one per line, to `calls` and exits with the code
function stubCommand(name: string, exitCode: number) {
    writeFileSync(join(folder, name), `#!/bin/sh\nprintf '%s\\n' ${name} "$@" '' >> "${folder}/calls"\nexit ${exitCode}\n`);
    chmodSync(join(folder, name), 0o755);
}

function deploy(tag = '1.0.0') {
    return Bun.spawnSync(['bash', script, tag, site, join(folder, 'deploy key'), join(folder, 'known hosts')], {
        env: { ...process.env, PATH: `${folder}:${process.env.PATH}`, SSH_HOST: 'host.uberspace.de', SSH_USER: 'decomp' },
    });
}

async function readCalls(): Promise<string[][]> {
    const file = Bun.file(join(folder, 'calls'));
    if (!(await file.exists())) {
        return [];
    }

    return (await file.text()).split('\n\n').filter(call => call !== '').map(call => call.split('\n'));
}

function sshOptions() {
    const key = join(folder, 'deploy key');
    const knownHosts = join(folder, 'known hosts');

    return ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`];
}

test("deploy uploads the site into the tag's folder and then switches the site to the release, also with spaces in the key's path", async () => {
    expect(deploy().exitCode).toBe(0);

    expect(await readCalls()).toEqual([
        [
            'rsync',
            '-a',
            '--delete',
            '--delay-updates',
            '--chmod=D755,F644',
            '-e',
            ['ssh', ...sshOptions()].map(word => `'${word}'`).join(' '),
            `${site}/`,
            'decomp@host.uberspace.de:1.0.0/',
        ],
        ['ssh', ...sshOptions(), 'decomp@host.uberspace.de', 'activate 1.0.0'],
    ]);
});

test("deploy ships host/htaccess as the site's .htaccess", async () => {
    deploy();

    expect(await Bun.file(join(site, '.htaccess')).text()).toBe(await Bun.file(htaccess).text());
});

test("deploy doesn't switch the site when the upload fails", async () => {
    stubCommand('rsync', 12);

    expect(deploy().exitCode).toBe(12);
    expect((await readCalls()).map(([name]) => name)).toEqual(['rsync']);
});

test("deploy refuses a tag that isn't a version and doesn't upload anything", async () => {
    for (const tag of ['1.0', '01.0.0', 'v1.0.0', '1.0.0/..']) {
        const { exitCode, stderr } = deploy(tag);

        expect([exitCode, stderr.toString()]).toEqual([1, `${tag} isn't a version like 1.0.0.\n`]);
    }

    expect(await readCalls()).toEqual([]);
});

test("deploy refuses a site folder without index.html and doesn't upload anything", async () => {
    rmSync(join(site, 'index.html'));

    const { exitCode, stderr } = deploy();

    expect([exitCode, stderr.toString()]).toEqual([1, `${site} doesn't have an index.html.\n`]);
    expect(await readCalls()).toEqual([]);
});
