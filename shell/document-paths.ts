import { formatTarget, parseTarget } from '#contract/document';

/** The parts of a document's path: the engine's id, the view's id, the open file's id and the document row's key. */
export interface DocumentPath {
    engineId: string;
    viewId: string;
    fileId: number;
    key: number;
}

/**
 * Writes a document's path, like `/fake/code/1:2/Circle.code`, from the engine's id, the view's id, the document row's
 * target and the row's name with the view's extension, which the tab shows.
 */
export function formatDocumentPath({ engineId, viewId, fileId, key }: DocumentPath, name: string, extension: string): string {
    return `/${engineId}/${viewId}/${formatTarget({ fileId, key })}/${name.replaceAll('/', '%2F')}${extension}`;
}

/** Reads the parts of a document's path, or returns `undefined` for a path without a row target. */
export function parseDocumentPath(path: string): DocumentPath | undefined {
    const [, engineId, viewId, target = ''] = path.split('/');
    try {
        const parsed = parseTarget(target);

        return 'fileId' in parsed ? { engineId, viewId, fileId: parsed.fileId, key: parsed.key } : undefined;
    } catch {
        return undefined;
    }
}
