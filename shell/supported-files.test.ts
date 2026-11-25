import { readManifest } from '#contract/manifest';
import { expect, test } from 'bun:test';
import { writeSupportedFiles } from './supported-files';

const views = [{ id: 'c', title: 'C', extension: '.c', language: 'c' }];

test('writeSupportedFiles writes a row for each manifest, in the order of the format texts', () => {
    const fileNote = 'and files without an extension';
    const asmView = { ...views[0], id: 'asm', title: 'Asm & <C>', extension: '.s' };
    const manifests = [
        readManifest({ id: 'native', name: 'Native', extensions: ['.so', '.elf'], views, formats: 'Native programs', fileNote }),
        readManifest({ id: 'cpp', name: 'C++', extensions: ['.o'], views: [...views, asmView] }),
    ];

    expect(writeSupportedFiles(manifests)).toBe(
        '<tr><td>C++</td><td><code>.o</code></td><td>C, Asm &amp; &lt;C&gt;</td></tr>'
            + '<tr><td>Native programs</td><td><code>.so</code>, <code>.elf</code> and files without an extension</td><td>C</td></tr>',
    );
});
