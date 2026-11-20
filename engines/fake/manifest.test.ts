import { expect, test } from 'bun:test';
import { fakeManifest } from '../../contract/fake';
import { readManifest } from '../../contract/manifest';
import manifest from './manifest.json' with { type: 'json' };

test("fake engine's JSON manifest is the contract's fake manifest", () => {
    expect(readManifest(manifest)).toEqual(fakeManifest);
});
