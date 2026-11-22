import { readManifest } from '#contract/manifest';
import { expect, test } from 'bun:test';
import manifest from './manifest.json' with { type: 'json' };

test("il2cpp engine's manifest claims metadata by its magic, keeps its worker up to 1 GiB and keeps its binary", () => {
    expect(readManifest(manifest)).toEqual({
        id: 'il2cpp',
        name: 'IL2CPP',
        extensions: ['.dat'],
        magics: ['af1bb1fa'],
        views: [{ id: 'csharp', title: 'C#', extension: '.cs', language: 'csharp' }],
        memoryLimitBytes: 1073741824,
        cancelLimitMs: 10000,
        keepsCompanions: true,
        formats: 'Unity IL2CPP games',
        fileNote: 'files like global-metadata.dat plus GameAssembly.dll or libil2cpp.so',
    });
});
