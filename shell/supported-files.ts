import type { Manifest } from '../contract/manifest';

function escapeHtml(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// writes the extensions as code, separated by commas, with the manifest's note after them
function writeRow({ name, formats = name, extensions, fileNote, views }: Manifest): string {
    const files = extensions.map(extension => `<code>${escapeHtml(extension)}</code>`).join(', ');
    const note = fileNote ? ` ${escapeHtml(fileNote)}` : '';
    const titles = escapeHtml(views.map(view => view.title).join(', '));

    return `<tr><td>${escapeHtml(formats)}</td><td>${files}${note}</td><td>${titles}</td></tr>`;
}

/**
 * Writes the rows of the About tab's table of supported files, one for each manifest in the order of their format
 * texts, which the site's build puts into the page so the table shows before the engines load.
 */
export function writeSupportedFiles(manifests: Manifest[]): string {
    return manifests
        .toSorted((first, second) => (first.formats ?? first.name).localeCompare(second.formats ?? second.name))
        .map(writeRow)
        .join('');
}
