import { expect, test } from 'bun:test';
import { readBuildVersion, writeVersionLine } from './build-version';

const commit = '425ab6358e058d802cb927bb0caa260625d6d46a';

test("tag build in GitHub Actions takes the tag's version and the workflow's commit", () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: '1.0.3', GITHUB_SHA: commit };

    expect(readBuildVersion(env, () => 'unused')).toEqual({ version: '1.0.3', commit });
});

test("branch build in GitHub Actions is a dev build of the workflow's commit", () => {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_SHA: commit };

    expect(readBuildVersion(env, () => 'unused')).toEqual({ version: 'dev', commit });
});

test('local build is a dev build of the checked out commit', () => {
    expect(readBuildVersion({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: '9.9.9' }, () => commit)).toEqual({ version: 'dev', commit });
});

test('version line links a release to its release page and a dev build to its commit', () => {
    expect(writeVersionLine({ version: '1.0.3', commit })).toBe(
        'Version <a href="https://github.com/ero-qt/decomp.loter.dev/releases/tag/1.0.3" target="_blank" rel="noopener noreferrer">1.0.3</a>'
            + ` (<a href="https://github.com/ero-qt/decomp.loter.dev/commit/${commit}" target="_blank" rel="noopener noreferrer">425ab63</a>)`,
    );
    expect(writeVersionLine({ version: 'dev', commit })).toBe(
        `Version dev (<a href="https://github.com/ero-qt/decomp.loter.dev/commit/${commit}" target="_blank" rel="noopener noreferrer">425ab63</a>)`,
    );
});
