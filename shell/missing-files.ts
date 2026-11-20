import type { MarkdownString } from 'vscode';

/** The command that picks an open file's missing file, with the missing file's name and the open file's path. */
export const loadMissingFileCommand = 'decomp.loadMissingFile';

/**
 * Returns the extension of a missing file's name for the file dialog, or an empty list for a name without an extension.
 */
export function findMissingFileExtensions(name: string): string[] {
    const extension = /\.[A-Za-z0-9]+$/.exec(name)?.[0];

    return extension ? [extension] : [];
}

/**
 * Appends the markdown link that runs `loadMissingFileCommand` with a missing file's name and the open file's path, and
 * trusts only that command.
 */
export function appendLoadLink(markdown: MarkdownString, name: string, path: string): MarkdownString {
    // writes `%`, `(` and `)` as JSON escapes because the link goes through markdown, which ends a link at `)`, and
    // through 2 decodes
    const json = JSON.stringify([name, path]).replace(/[%()]/g, character => `\\u00${character.charCodeAt(0).toString(16)}`);
    markdown.appendMarkdown(` [Click here to load](command:${loadMissingFileCommand}?${encodeURIComponent(json)}).`);
    markdown.isTrusted = { enabledCommands: [loadMissingFileCommand] };

    return markdown;
}
