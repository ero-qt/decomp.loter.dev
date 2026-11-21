import { expect, test } from 'bun:test';
import { readReleaseNotes } from './notes';

const changelog = `# Changelog

## [Unreleased]

### Added

- Something new.

## [1.1.0] - 2026-12-01

### Added

- A second engine.

### Fixed

- A crash.

## [1.0.0] - 2026-11-21

### Added

- The site.

[Unreleased]: https://github.com/ero-qt/decomp.loter.dev/compare/1.1.0...HEAD
[1.1.0]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.0...1.1.0
[1.0.0]: https://github.com/ero-qt/decomp.loter.dev/releases/tag/1.0.0
`;

test("release notes are the version's section without its heading, up to the next version", () => {
    expect(readReleaseNotes(changelog, '1.1.0')).toBe('### Added\n\n- A second engine.\n\n### Fixed\n\n- A crash.\n');
});

test("release notes of the oldest version end before the changelog's links", () => {
    expect(readReleaseNotes(changelog, '1.0.0')).toBe('### Added\n\n- The site.\n');
});

test('release notes fail for a version without a section and for the Unreleased section', () => {
    expect(() => readReleaseNotes(changelog, '1.2.0')).toThrow("changelog.md doesn't have a section for 1.2.0");
    expect(() => readReleaseNotes(changelog, 'Unreleased')).toThrow("Unreleased isn't a version like 1.0.0");
    expect(() => readReleaseNotes(changelog, '1.0')).toThrow("1.0 isn't a version like 1.0.0");
});

test('changelog links each of its sections', async () => {
    const text = await Bun.file(new URL('../changelog.md', import.meta.url)).text();
    const sections = [...text.matchAll(/^## \[([^\]]+)\]/gm)].map(([, name]) => name);
    const links = [...text.matchAll(/^\[([^\]]+)\]: https:\/\/github\.com\/ero-qt\/decomp\.loter\.dev\//gm)].map(([, name]) => name);

    expect(links).toEqual(sections);
});
