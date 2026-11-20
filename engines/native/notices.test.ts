import { expect, test } from 'bun:test';
import { listVendorSubmodules } from './build/sources';
import versions from './build/versions.json' with { type: 'json' };

// the pinned subprojects of versions.json, each with the commit or tarball that pins it
const pinnedSubprojects = versions.subprojects.map(subproject => ({ url: subproject.url, pin: subproject.commit ?? subproject.file }));

test('notices name every subproject of versions.json, link the commit of each submodule and point at the served sources', async () => {
    const notices = await Bun.file(new URL('../../third-party-notices.md', import.meta.url)).text();

    for (const { url, pin } of pinnedSubprojects) {
        expect(notices).toContain(url.replace(/\.git$/, ''));
        expect(notices).toContain(pin!);
    }
    for (const { url, commit } of listVendorSubmodules()) {
        expect(notices).toContain(`${url.replace(/\.git$/, '')}/tree/${commit}`);
    }
    expect(notices).toContain('`engines/native/source`');
    expect(notices).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(notices).toContain('GNU GENERAL PUBLIC LICENSE');
});

test("notices list rizin's files under other licenses, tree-sitter's unicode headers and llvm's libunwind", async () => {
    const notices = await Bun.file(new URL('../../third-party-notices.md', import.meta.url)).text();
    const files = [
        'librz/hash/algorithms/sha2/sha2.c',
        'librz/hash/randomart.c',
        'librz/util/getopt.c',
        'librz/bin/format/pe/dotnet.c',
        'librz/hash/algorithms/md5/md5.c',
        'librz/hash/algorithms/sm3/sm3.c',
        'librz/util/sdb/src/cdb.c',
    ];

    for (const file of files) {
        expect(notices).toContain(`\`${file}\``);
    }
    expect(notices).toContain('COPYRIGHT AND PERMISSION NOTICE (ICU 58 and later)');
    expect(notices).toContain('libunwind');
});
