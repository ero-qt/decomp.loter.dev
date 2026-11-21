import { expect, test } from 'bun:test';
import { readManifest } from '../../contract/manifest';
import manifest from './manifest.json' with { type: 'json' };

test("java engine's JSON manifest names its views, the files that the engine claims and a cancel limit that lets a decompile finish", () => {
    expect(readManifest(manifest)).toEqual({
        id: 'java',
        name: 'Java',
        extensions: ['.jar', '.war', '.class'],
        magics: ['cafebabe', '504b0304'],
        views: [
            { id: 'java', title: 'Java', extension: '.java', language: 'java' },
            { id: 'bytecode', title: 'Bytecode', extension: '.bytecode', language: 'bytecode' },
        ],
        hasLinkedFiles: true,
        cancelLimitMs: 10000,
    });
});
