import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('receive-deploy.sh', import.meta.url).pathname;
const htaccess = await Bun.file(new URL('htaccess', import.meta.url)).text();
// a file of each type that the host could run, like a PHP script or a .htaccess that turns PHP on again
const runnableFiles = [
    'assets/.htaccess',
    '.user.ini',
    'a.php',
    'A.PHP',
    'a.php3',
    'a.php8',
    'a.phtml',
    'a.phar',
    'a.pht',
    'a.cgi',
    'a.pl',
    'a.py',
    'a.sh',
    'a.shtml',
    'a.inc',
];

let folder: string;
let web: string;
let secret: string;

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'receive-deploy-'));
    web = join(folder, 'web');
    mkdirSync(join(web, 'releases'), { recursive: true });
    mkdirSync(join(web, 'uploads'));
    writeFileSync(join(folder, 'receive-deploy.htaccess'), htaccess);
    // stands for a file outside the web folder that the key mustn't reach, like the dashboard's cookie
    secret = join(folder, 'secret');
    writeFileSync(secret, 'sessionid=abc');
    // writes an `rrsync` that records its arguments and the command that it got from SSH
    writeFileSync(join(folder, 'rrsync'), `#!/bin/sh\nprintf '%s\\n' "$@" "$SSH_ORIGINAL_COMMAND" > "${folder}/rrsync-args"\n`);
    chmodSync(join(folder, 'rrsync'), 0o755);
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

// writes a release into the uploads folder like rrsync, with index.html, the host's .htaccess and the files, which can
// replace the first 2
function upload(tag: string, files: Record<string, string> = {}) {
    const release = join(web, 'uploads', tag);
    mkdirSync(release);
    for (const [path, text] of Object.entries({ 'index.html': tag, '.htaccess': htaccess, ...files })) {
        mkdirSync(join(release, path, '..'), { recursive: true });
        writeFileSync(join(release, path), text);
    }

    return release;
}

function receive(command: string) {
    return Bun.spawnSync(['bash', script, web, join(folder, 'receive-deploy.htaccess')], {
        env: { ...process.env, PATH: `${folder}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command },
    });
}

function activate(tag: string) {
    const { exitCode, stderr } = receive(`activate ${tag}`);

    return { exitCode, error: stderr.toString() };
}

function readLive() {
    return readlinkSync(join(web, 'html'));
}

function listReleases() {
    return readdirSync(join(web, 'releases')).sort();
}

test('receiver hands an upload to rrsync, which only writes into the uploads folder and munges links', async () => {
    const command = 'rsync --server -logDtpre.iLsfxCIvu --delete --delay-updates . 1.0.0/';

    expect(receive(command).exitCode).toBe(0);
    expect((await Bun.file(join(folder, 'rrsync-args')).text()).split('\n')).toEqual(['-wo', '-munge', join(web, 'uploads'), command, '']);
});

test("activate copies the upload into the releases, where the key can't write, and points the site at it", () => {
    upload('1.0.0');

    expect(activate('1.0.0')).toEqual({ exitCode: 0, error: '' });
    expect(readLive()).toBe('releases/1.0.0');
    expect(listReleases()).toEqual(['1.0.0']);
    expect(readdirSync(join(web, 'uploads'))).toEqual([]);
    expect(readdirSync(web).sort()).toEqual(['html', 'releases', 'uploads']);
});

// rsync's receiver changes into the upload's folder and writes by relative path, so it follows a rename of the folder
test("a write into the upload after activate doesn't reach the release", async () => {
    const release = upload('1.0.0');
    const writer = Bun.spawn(['sh', '-c', 'read line; echo late > late.php'], { cwd: release, stdin: 'pipe', stderr: 'ignore' });

    expect(activate('1.0.0').exitCode).toBe(0);

    writer.stdin.write('\n');
    writer.stdin.end();
    await writer.exited;

    expect(readdirSync(join(web, 'releases', '1.0.0')).sort()).toEqual(['.htaccess', 'index.html']);
});

test('activate replaces the link to the live release', () => {
    upload('1.0.0');
    upload('1.0.1');
    activate('1.0.0');

    expect(activate('1.0.1').exitCode).toBe(0);
    expect(readLive()).toBe('releases/1.0.1');
});

test('activate switches back to an older release without an upload', () => {
    upload('1.0.0');
    upload('1.0.1');
    activate('1.0.0');
    activate('1.0.1');

    expect(activate('1.0.0').exitCode).toBe(0);
    expect(readLive()).toBe('releases/1.0.0');
});

test("activate copies the live release's balance into the new release", async () => {
    upload('1.0.0');
    upload('1.0.1');
    activate('1.0.0');
    writeFileSync(join(web, 'html', 'balance.json'), '{"balance":"12.50"}');

    expect(activate('1.0.1').exitCode).toBe(0);
    expect(await Bun.file(join(web, 'html', 'balance.json')).text()).toBe('{"balance":"12.50"}');
    expect(readdirSync(join(web, 'releases', '1.0.1')).sort()).toEqual(['.htaccess', 'balance.json', 'index.html']);
});

test('activate works without a balance', () => {
    upload('1.0.0');

    expect(activate('1.0.0').exitCode).toBe(0);
    expect(existsSync(join(web, 'html', 'balance.json'))).toBe(false);
});

test("activate doesn't copy a live balance that is a link, like a link to the dashboard's cookie", () => {
    upload('1.0.0');
    upload('1.0.1');
    activate('1.0.0');
    symlinkSync(secret, join(web, 'html', 'balance.json'));

    expect(activate('1.0.1').exitCode).toBe(0);
    expect(existsSync(join(web, 'releases', '1.0.1', 'balance.json'))).toBe(false);
});

test("activate refuses to replace the live release, so a deploy that runs again keeps the live release's balance", async () => {
    upload('1.0.0');
    activate('1.0.0');
    writeFileSync(join(web, 'html', 'balance.json'), '{"balance":"12.50"}');
    upload('1.0.0', { 'index.html': 'again' });

    expect(activate('1.0.0')).toEqual({ exitCode: 1, error: 'The release 1.0.0 is live. Upload a new version.\n' });
    expect(await Bun.file(join(web, 'html', 'balance.json')).text()).toBe('{"balance":"12.50"}');
    expect(await Bun.file(join(web, 'html', 'index.html')).text()).toBe('1.0.0');
});

test("activate replaces an older release that isn't live with a new upload of the same version", async () => {
    upload('1.0.0');
    upload('1.0.1');
    activate('1.0.0');
    activate('1.0.1');
    upload('1.0.0', { 'index.html': 'again' });

    expect(activate('1.0.0').exitCode).toBe(0);
    expect(await Bun.file(join(web, 'html', 'index.html')).text()).toBe('again');
});

test('activate keeps the newest 3 releases', () => {
    for (const tag of ['0.0.0', '1.0.0', '1.0.1', '1.2.0', '1.10.0']) {
        upload(tag);
        activate(tag);
    }

    expect(listReleases()).toEqual(['1.0.1', '1.10.0', '1.2.0']);
});

test('activate never removes the live release, also when it is an old one', () => {
    for (const tag of ['1.0.1', '1.0.2', '1.0.3', '1.0.0']) {
        upload(tag);
        activate(tag);
    }

    expect(readLive()).toBe('releases/1.0.0');
    expect(listReleases()).toEqual(['1.0.0', '1.0.1', '1.0.2', '1.0.3']);
});

test("activate of a release that isn't uploaded fails and leaves the site alone", () => {
    upload('1.0.0');
    activate('1.0.0');
    mkdirSync(join(web, 'uploads', '1.0.1'));

    expect(activate('1.0.1')).toEqual({ exitCode: 1, error: "The release 1.0.1 isn't uploaded.\n" });
    expect(readLive()).toBe('releases/1.0.0');
});

test("activate refuses an upload that is a link and leaves the link's target alone", () => {
    upload('1.0.0');
    activate('1.0.0');
    const elsewhere = join(folder, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'index.html'), '');
    symlinkSync(elsewhere, join(web, 'uploads', '1.0.1'));

    expect(activate('1.0.1')).toEqual({ exitCode: 1, error: 'The release 1.0.1 is a link.\n' });
    expect(readLive()).toBe('releases/1.0.0');
    expect(readdirSync(elsewhere)).toEqual(['index.html']);
});

test('activate refuses a release with a link anywhere in it, like a link to authorized_keys', async () => {
    upload('1.0.0');
    activate('1.0.0');
    writeFileSync(join(web, 'html', 'balance.json'), '{"balance":"12.50"}');

    for (const path of ['balance.json', 'balance.json.new', 'assets/keys']) {
        const release = upload('1.0.1', { 'assets/a.js': '' });
        symlinkSync(secret, join(release, path));

        expect(activate('1.0.1')).toEqual({ exitCode: 1, error: `The release 1.0.1 has a link: ${path}.\n` });
        expect(readLive()).toBe('releases/1.0.0');
        expect(await Bun.file(secret).text()).toBe('sessionid=abc');
    }
});

test('activate refuses a release with a file that the host could run', () => {
    upload('1.0.0');
    activate('1.0.0');

    for (const path of runnableFiles) {
        upload('1.0.1', { [path]: '<?php readfile("/home/decomp/.config/decomp/dashboard-cookie");' });

        expect([path, activate('1.0.1')]).toEqual([path, { exitCode: 1, error: `The release 1.0.1 has a file that the host could run: ${path}.\n` }]);
        expect(readLive()).toBe('releases/1.0.0');
    }
});

test(".htaccess of a release has to match the host's copy, so a deploy can't loosen it", () => {
    upload('1.0.0');
    activate('1.0.0');

    for (const files of [{ '.htaccess': `${htaccess}SetHandler php-fcgi\n` }, { '.htaccess': '' }]) {
        upload('1.0.1', files);

        expect(activate('1.0.1')).toEqual({ exitCode: 1, error: "The release 1.0.1's .htaccess differs from the host's copy.\n" });
        expect(readLive()).toBe('releases/1.0.0');
    }
});

test("receiver refuses each other command and doesn't change anything", () => {
    upload('1.0.0');
    activate('1.0.0');

    for (const command of ['activate ../x', 'activate 1.0', 'activate 01.0.0', 'activate 1.0.0; rm -rf ~', '', 'bash', 'rsync --sender .']) {
        const { exitCode } = receive(command);

        expect([command, exitCode]).toEqual([command, 1]);
        expect(readLive()).toBe('releases/1.0.0');
        expect(listReleases()).toEqual(['1.0.0']);
        expect(existsSync(join(folder, 'rrsync-args'))).toBe(false);
    }
});
