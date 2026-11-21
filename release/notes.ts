const version = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Reads the changelog's section of the version without its heading, up to the next section or the links. */
export function readReleaseNotes(changelog: string, tag: string): string {
    if (!version.test(tag)) {
        throw new Error(`${tag} isn't a version like 1.0.0`);
    }

    const lines = changelog.split('\n');
    const start = lines.findIndex(line => line.startsWith(`## [${tag}]`));
    if (start < 0) {
        throw new Error(`changelog.md doesn't have a section for ${tag}`);
    }

    const end = lines.findIndex((line, index) => index > start && (line.startsWith('## [') || /^\[[^\]]+\]: /.test(line)));

    return `${lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()}\n`;
}

if (import.meta.main) {
    try {
        process.stdout.write(readReleaseNotes(await Bun.file(new URL('../changelog.md', import.meta.url)).text(), Bun.argv[2] ?? ''));
    } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
    }
}
