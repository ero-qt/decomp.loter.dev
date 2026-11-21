const repository = 'https://github.com/ero-qt/decomp.loter.dev';
const linkAttributes = 'target="_blank" rel="noopener noreferrer"';

/** The version and the full commit hash that a build of the site shows. */
export interface BuildVersion {
    version: string;
    commit: string;
}

/**
 * Reads the build's version from GitHub Actions' variables, the tag for a tag's workflow and `dev` for any other build,
 * with the workflow's commit or else the commit that `readCommit` returns.
 */
export function readBuildVersion(env: Record<string, string | undefined>, readCommit: () => string): BuildVersion {
    if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_SHA) {
        return { version: env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME! : 'dev', commit: env.GITHUB_SHA };
    }

    return { version: 'dev', commit: readCommit() };
}

/** Writes the About tab's version line, which links a release to its release page and the commit to its page. */
export function writeVersionLine({ version, commit }: BuildVersion): string {
    const commitLink = `<a href="${repository}/commit/${commit}" ${linkAttributes}>${commit.slice(0, 7)}</a>`;
    const versionText = version === 'dev' ? version : `<a href="${repository}/releases/tag/${version}" ${linkAttributes}>${version}</a>`;

    return `Version ${versionText} (${commitLink})`;
}
