import { expect, mock, test } from 'bun:test';
import type { TextDocument, Uri } from 'vscode';
import type { RowDocuments } from './documents';
import type { OpenFile, OpenFiles, ReadDocument } from './files';

mock.module('./api', () => ({ vscode: { CancellationError: class extends Error {} } }));
const { SymbolFeatures } = await import('./symbol-features');

test("an outline request for the text of a partial read gets canceled once the next read came, whose places don't fit the text", async () => {
    const file = { siteEngine: { manifest: { id: 'test' } }, fileId: 1 } as OpenFile;
    const read: ReadDocument = { text: 'class Listed\n{\n    return;\n}', tokens: [], locals: [] };
    const documents = { readOpenDocument: async () => ({ file, viewId: 'code', key: 16, read }) } as unknown as RowDocuments;
    const openFiles = { list: async () => ({ rows: [], missingFiles: [] }) } as unknown as OpenFiles;
    const features = new SymbolFeatures(openFiles, documents);
    const textDocument = { uri: {} as Uri, getText: () => 'class Listed\n// …' } as unknown as TextDocument;

    await expect(features.provideDocumentSymbols(textDocument)).rejects.toThrow();
});
