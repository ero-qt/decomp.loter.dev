import { readManifest } from '#contract/manifest';
import { expect, test } from 'bun:test';
import manifest from './manifest.json' with { type: 'json' };

test("il2cpp engine's manifest claims metadata by its magic, keeps its worker up to 3 GiB and opens the binary's own file later", () => {
    expect(readManifest(manifest)).toEqual({
        id: 'il2cpp',
        name: 'IL2CPP',
        extensions: ['.dat'],
        magics: ['af1bb1fa'],
        views: [{ id: 'csharp', title: 'C#', extension: '.cs', language: 'csharp' }],
        memoryLimitBytes: 3221225472,
        cancelLimitMs: 10000,
        repliesDuringReads: true,
        keepsCompanions: true,
        unlistedView: { id: 'c', title: 'C', extension: '.c', language: 'c' },
        formats: 'Unity IL2CPP games',
        fileNote: 'files like global-metadata.dat plus GameAssembly.dll or libil2cpp.so',
    });
});
