import { expect, test } from 'bun:test';
import { readManifest } from '../../contract/manifest';
import manifest from './manifest.json' with { type: 'json' };

test("dotnet engine's JSON manifest names the C# and IL views, PE files and limits that let a decompile finish", () => {
    expect(readManifest(manifest)).toEqual({
        id: 'dotnet',
        name: '.NET',
        extensions: ['.dll', '.exe', '.winmd'],
        magics: ['4d5a'],
        views: [
            { id: 'csharp', title: 'C#', extension: '.cs', language: 'csharp' },
            { id: 'il', title: 'IL', extension: '.il', language: 'il' },
        ],
        hasLinkedFiles: true,
        memoryLimitBytes: 536870912,
        cancelLimitMs: 10000,
        priority: 10,
        formats: '.NET assemblies',
    });
});
