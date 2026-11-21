import { Glob } from 'bun';
import { expect, test } from 'bun:test';
import { siteHeaders } from '../shell/headers';
import { readHtaccessLines, readLongCachePatterns } from './htaccess-testing';

const lines = await readHtaccessLines();
const siteFolder = new URL('../artifacts/site/', import.meta.url).pathname;
// a file of each type that the host could run as a script
const scriptFiles = ['a.php', 'A.PHP', 'a.php3', 'a.php8', 'a.phtml', 'a.phar', 'a.pht', 'a.cgi', 'a.pl', 'a.py', 'a.sh', 'a.shtml', 'a.inc'];
// the files whose names stay the same from build to build
const lastingNames = new RegExp(
    '^/(index\\.html|privacy\\.html|robots\\.txt|sitemap\\.xml|balance\\.json|engines/index\\.json|engines/[^/]+/(manifest\\.json|worker\\.js)'
        + '|engines/dotnet/(_framework/dotnet\\.js|THIRD-PARTY-NOTICES\\.TXT)|engines/native/(rizin\\.mjs|rizin\\.wasm|(share|sleigh|source)/.+))$',
);

interface HeaderDirective {
    condition: string;
    action: string;
    name: string;
    value: string | undefined;
    /** The names of the blocks around the directive, like `If`, from the outside in. */
    blocks: string[];
}

// reads each `Header` directive with its condition, like `always`, its action, like `set` or `unset`, and the blocks
// around it
function readHeaderDirectives(): HeaderDirective[] {
    const blocks: string[] = [];
    const directives: HeaderDirective[] = [];

    for (const line of lines) {
        const [, closed] = /^<\/(\w+)>$/.exec(line) ?? [];
        const [, opened] = /^<(\w+)[\s>]/.exec(line) ?? [];
        const [, condition = '', action, name, value] = /^Header (?:(always|onsuccess) )?(\w+) (\S+)(?: "(.*)")?$/.exec(line) ?? [];
        if (closed) {
            blocks.pop();
        } else if (opened) {
            blocks.push(opened);
        } else if (action) {
            directives.push({ condition, action, name, value, blocks: [...blocks] });
        }
    }

    return directives;
}

// lists the path of each file of the built site, without a `.htaccess` that a deploy put into the folder
async function listSitePaths(): Promise<string[]> {
    const paths = await Array.fromAsync(new Glob('**/*').scan({ cwd: siteFolder, dot: true }));

    return paths.filter(path => path !== '.htaccess').map(path => `/${path}`).sort();
}

test('htaccess has only Header directives that the test reads', () => {
    expect(readHeaderDirectives().length).toBe(lines.filter(line => line.startsWith('Header')).length);
});

test("htaccess sets each of the site's headers once, outside each block, with every response, also with a missing file", () => {
    const names = Object.keys(siteHeaders);
    const securityDirectives = readHeaderDirectives().filter(({ name }) => names.includes(name));

    expect(securityDirectives.map(({ condition, action, blocks }) => [condition, action, blocks])).toEqual(names.map(() => ['always', 'set', []]));
    expect(Object.fromEntries(securityDirectives.map(({ name, value }) => [name, value]))).toEqual(siteHeaders);
});

test('htaccess sends the cache header only with a found file', () => {
    const cacheDirectives = readHeaderDirectives().filter(({ name }) => name === 'Cache-Control');

    expect(cacheDirectives.map(({ condition, action }) => [condition, action])).toEqual(Array(4).fill(['', 'set']));
});

test('htaccess keeps each file with a fingerprint for a year and lets browsers ask again for each other file of the site', async () => {
    const patterns = await readLongCachePatterns();
    const isKeptLong = (path: string) => patterns.some(pattern => pattern.test(path));
    const paths = await listSitePaths();
    paths.push('/balance.json');

    expect(paths.filter(path => !isKeptLong(path))).toEqual(paths.filter(path => lastingNames.test(path)));
    expect(paths.filter(path => path.startsWith('/assets/')).every(isKeptLong)).toBe(true);
    expect(paths.filter(path => /^\/engines\/dotnet\/_framework\/(?!dotnet\.js$)/.test(path)).every(isKeptLong)).toBe(true);
    expect(paths.filter(path => path.startsWith('/engines/java/vf.runtime-')).map(isKeptLong)).toEqual([true]);
});

test('htaccess sends wasm and module scripts with their types', () => {
    expect(lines).toContain('AddType application/wasm .wasm');
    expect(lines).toContain('AddType text/javascript .mjs');
});

test("htaccess turns off folder listings, CGI and includes and doesn't let the host run a script file", async () => {
    const [, pattern] = /^<FilesMatch "\(\?i\)(.+)">$/.exec(lines.find(line => line.startsWith('<FilesMatch')) ?? '') ?? [];
    const scriptFile = new RegExp(pattern, 'i');
    const block = lines.slice(lines.indexOf(`<FilesMatch "(?i)${pattern}">`) + 1, lines.indexOf('</FilesMatch>'));

    expect(lines).toContain('Options -ExecCGI -Includes -Indexes');
    expect(block).toEqual(['SetHandler none', 'Require all denied']);
    expect(scriptFiles.filter(name => !scriptFile.test(name))).toEqual([]);
    expect((await listSitePaths()).filter(path => scriptFile.test(path))).toEqual([]);
});
