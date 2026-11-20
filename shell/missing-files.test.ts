import { expect, test } from 'bun:test';
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import { MarkdownString } from '@codingame/monaco-vscode-api/vscode/vs/workbench/api/common/extHostTypes/markdownString';
import { appendLoadLink, findMissingFileExtensions, loadMissingFileCommand } from './missing-files';

// reads the arguments of the link's command like the workbench, which decodes the link's query twice
function readLinkArguments(markdown: string): unknown {
    const [, target] = /^ \[Click here to load\]\(([^()\s]+)\)\.$/.exec(markdown) ?? [];
    const uri = URI.parse(target);

    return uri.path === loadMissingFileCommand ? JSON.parse(decodeURIComponent(uri.query)) : undefined;
}

test("findMissingFileExtensions returns the last extension of a missing file's name", () => {
    expect(findMissingFileExtensions('app.pdb')).toEqual(['.pdb']);
    expect(findMissingFileExtensions('System.Runtime.dll')).toEqual(['.dll']);
    expect(findMissingFileExtensions('System.Runtime')).toEqual(['.Runtime']);
});

test("findMissingFileExtensions returns an empty list for a missing file's name without an extension of letters and digits", () => {
    expect(findMissingFileExtensions('readme')).toEqual([]);
    expect(findMissingFileExtensions('v1.0 final')).toEqual([]);
    expect(findMissingFileExtensions('lib/a.b/c')).toEqual([]);
    expect(findMissingFileExtensions('a.p,db')).toEqual([]);
});

test("appendLoadLink appends a link whose command gets the missing file's name and the file's path", () => {
    const names = ['[x](command:decomp.close).notes', 'a%41.pdb', '100%.dll', 'ü 日本.dll', 'a\ud800.dll'];
    const paths = ['bin/a b.fake', 'my%20app (1).fake', 'dir/ö).fake'];
    for (const name of names) {
        for (const path of paths) {
            expect(readLinkArguments(appendLoadLink(new MarkdownString(), name, path).value)).toEqual([name, path]);
        }
    }
});

test('appendLoadLink trusts only the load command', () => {
    expect(appendLoadLink(new MarkdownString(), 'app.pdb', 'app.fake').isTrusted).toEqual({ enabledCommands: [loadMissingFileCommand] });
});
