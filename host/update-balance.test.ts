import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBalance } from '../shell/support';

const script = new URL('update-balance.sh', import.meta.url).pathname;
const accountInfo = {
    domains: { web: [], mail: {} },
    current_amount: '12.50',
    price: '9.00',
    min_price: '2.00',
    login: 'decomp',
};
const oldBalance = '{"balance":"1.00"}';

let folder: string;

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'balance-'));
    writeFileSync(join(folder, 'cookie'), 'sessionid=abc');
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

// writes a `curl` that records its arguments, the files in the folder and the config it reads from stdin. Like real
// curl, on a refused cookie it exits 22 with `-f` or `--fail` and prints the error page without them.
function stubCurl(response: string | undefined) {
    const reply = response === undefined ? `[ "$fail" ] && exit 22; printf '<html>forbidden</html>'` : `printf '%s' '${response}'`;
    writeFileSync(
        join(folder, 'curl'),
        `#!/bin/sh
printf '%s\\n' "$@" > "${folder}/argv"
ls -A "${folder}" > "${folder}/listing"
fail=
previous=
for arg; do
    case "$arg" in --fail) fail=1;; --*) ;; -*f*) fail=1;; esac
    case "$previous $arg" in '-K -'|'--config -') cat > "${folder}/config";; esac
    previous=$arg
done
${reply}
`,
    );
    chmodSync(join(folder, 'curl'), 0o755);
}

function runScript(site = folder) {
    return Bun.spawnSync([script, join(folder, 'cookie'), site], { env: { ...process.env, PATH: `${folder}:${process.env.PATH}` } });
}

async function expectOldBalanceKept(exitCode: number) {
    expect(exitCode).not.toBe(0);
    expect(await Bun.file(join(folder, 'balance.json')).text()).toBe(oldBalance);
    expect(readdirSync(folder).sort()).toEqual(['argv', 'balance.json', 'config', 'cookie', 'curl', 'listing']);
}

function stubAccountInfo(changes: Record<string, unknown>) {
    stubCurl(JSON.stringify({ ...accountInfo, ...changes }));
}

test('update-balance writes the balance, the price and the time from the account info', async () => {
    stubCurl(JSON.stringify(accountInfo));

    expect(runScript().exitCode).toBe(0);

    const written = await Bun.file(join(folder, 'balance.json')).json();
    expect(written).toEqual({ balance: '12.50', price: '9.00', asOf: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d\+00:00$/) });
    expect(await Bun.file(join(folder, 'config')).text()).toBe('header = "Cookie: sessionid=abc"\n');
});

test('update-balance writes a balance.json that everyone can read and that the support note accepts', async () => {
    stubCurl(JSON.stringify(accountInfo));

    runScript();

    expect(statSync(join(folder, 'balance.json')).mode & 0o777).toBe(0o644);
    expect(parseBalance(await Bun.file(join(folder, 'balance.json')).text())).toMatchObject({ balance: 12.5, price: 9 });
});

test("update-balance writes into the live release through the site folder's link", async () => {
    mkdirSync(join(folder, 'releases', '1.0.0'), { recursive: true });
    symlinkSync('releases/1.0.0', join(folder, 'html'));
    stubCurl(JSON.stringify(accountInfo));

    expect(runScript(join(folder, 'html')).exitCode).toBe(0);
    expect(readdirSync(join(folder, 'releases', '1.0.0'))).toEqual(['balance.json']);
});

test('update-balance keeps the cookie out of the arguments of curl', async () => {
    stubCurl(JSON.stringify(accountInfo));

    runScript();

    expect(await Bun.file(join(folder, 'argv')).text()).not.toContain('sessionid');
});

test('update-balance accepts a cookie file with a whole Cookie line and a CRLF ending', async () => {
    writeFileSync(join(folder, 'cookie'), 'Cookie: sessionid=abc\r\n');
    stubCurl(JSON.stringify(accountInfo));

    expect(runScript().exitCode).toBe(0);
    expect(await Bun.file(join(folder, 'config')).text()).toBe('header = "Cookie: sessionid=abc"\n');
});

test('update-balance writes a number in the account info as its decimal text', async () => {
    stubCurl(JSON.stringify(accountInfo).replace('"12.50"', '12.50'));

    expect(runScript().exitCode).toBe(0);
    expect((await Bun.file(join(folder, 'balance.json')).json()).balance).toBe('12.50');
});

test('update-balance keeps the old balance when the dashboard refuses the cookie', async () => {
    writeFileSync(join(folder, 'balance.json'), oldBalance);
    stubCurl(undefined);

    const { exitCode } = runScript();

    // curl gives 22 for an HTTP error only with --fail
    expect(exitCode).toBe(22);
    await expectOldBalanceKept(exitCode);
});

test("update-balance keeps the old balance when the account info isn't JSON", async () => {
    writeFileSync(join(folder, 'balance.json'), oldBalance);
    stubCurl('<html>login</html>');

    await expectOldBalanceKept(runScript().exitCode);
});

test('update-balance keeps the old balance when the account info lacks the balance', async () => {
    writeFileSync(join(folder, 'balance.json'), oldBalance);
    stubAccountInfo({ current_amount: undefined });

    await expectOldBalanceKept(runScript().exitCode);
});

test('update-balance keeps the old balance when the balance is null', async () => {
    writeFileSync(join(folder, 'balance.json'), oldBalance);
    stubAccountInfo({ current_amount: null });

    await expectOldBalanceKept(runScript().exitCode);
});

test('update-balance keeps the old balance when the price has a decimal comma', async () => {
    writeFileSync(join(folder, 'balance.json'), oldBalance);
    stubAccountInfo({ price: '9,00' });

    await expectOldBalanceKept(runScript().exitCode);
});

test('update-balance accepts a Cookie line in any case and with spaces around it', async () => {
    writeFileSync(join(folder, 'cookie'), '  cookie:  sessionid=abc  \n');
    stubCurl(JSON.stringify(accountInfo));

    expect(runScript().exitCode).toBe(0);
    expect(await Bun.file(join(folder, 'config')).text()).toBe('header = "Cookie: sessionid=abc"\n');
});

test("update-balance refuses a cookie file with more than one line, so nothing else reaches curl's config", async () => {
    writeFileSync(join(folder, 'balance.json'), oldBalance);
    writeFileSync(join(folder, 'cookie'), 'sessionid=abc\nurl = "https://example.com"\n');
    stubCurl(JSON.stringify(accountInfo));

    const { exitCode, stderr } = runScript();

    expect([exitCode, stderr.toString()]).toEqual([1, 'The cookie file has more than one line.\n']);
    expect(await Bun.file(join(folder, 'balance.json')).text()).toBe(oldBalance);
    expect(readdirSync(folder).sort()).toEqual(['balance.json', 'cookie', 'curl']);
});

test("update-balance makes its temp file only after curl's response, so a release switch during the request leaves nothing behind", async () => {
    stubCurl(JSON.stringify(accountInfo));

    runScript();

    expect((await Bun.file(join(folder, 'listing')).text()).split('\n').filter(name => name.startsWith('balance.json'))).toEqual([]);
});
