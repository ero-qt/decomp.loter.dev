import { expect, test } from 'bun:test';
import { readManifest } from '../../contract/manifest';
import manifest from './manifest.json' with { type: 'json' };

test("native engine's JSON manifest names the C view, ELF, PE and Mach-O files and limits for a long decompile", () => {
    expect(readManifest(manifest)).toEqual({
        id: 'native',
        name: 'Native',
        extensions: ['.exe', '.dll', '.sys', '.efi', '.so', '.dylib', '.elf'],
        magics: ['7f454c46', '4d5a', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'],
        views: [{ id: 'c', title: 'C', extension: '.c', language: 'c' }],
        memoryLimitBytes: 1073741824,
        cancelLimitMs: 2000,
    });
});
