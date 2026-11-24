import { CanceledError } from '#contract/reply';
import { expect, mock, test } from 'bun:test';
import type { CancellationToken, TextDocument, Uri } from 'vscode';
import { formatDocumentPath } from './document-paths';
import type { OpenFile, OpenFiles, ReadDocument } from './files';

class FakeEmitter<Value> {
    private readonly listeners: ((value: Value) => void)[] = [];
    readonly event = (listener: (value: Value) => void) => {
        this.listeners.push(listener);

        return { dispose: () => undefined };
    };

    fire(value: Value) {
        for (const listener of this.listeners) {
            listener(value);
        }
    }
}

// lists no tabs, like the extension's view of the tabs right after the workbench opened a tab
mock.module('./api', () => ({
    vscode: {
        EventEmitter: FakeEmitter,
        CancellationError: class extends Error {},
        TabInputText: class {},
        SemanticTokensBuilder: class {
            private readonly data: number[][] = [];
            push(...token: number[]) {
                this.data.push(token);
            }
            build() {
                return { data: this.data };
            }
        },
        workspace: { onDidCloseTextDocument: () => ({ dispose: () => undefined }) },
        window: {
            tabGroups: { all: [], onDidChangeTabs: () => ({ dispose: () => undefined }) },
            withProgress: (_options: unknown, task: () => Promise<void>) => task(),
        },
    },
}));
Object.assign(globalThis, { window: { addEventListener: () => undefined } });
const { RowDocuments } = await import('./documents');

const never: CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };

test("a token request whose read a search drops before the document's tab shows up gets the tokens on the next request", async () => {
    const reads: ((read: ReadDocument) => void)[] = [];
    const file = { siteEngine: { manifest: { id: 'test' } }, fileId: 1 } as OpenFile;
    const openFiles = {
        files: [file],
        onDidChange: () => ({ dispose: () => undefined }),
        read(_file: OpenFile, _key: number, _viewId: string, signal?: AbortSignal) {
            const { promise, resolve, reject } = Promise.withResolvers<ReadDocument>();
            signal?.addEventListener('abort', () => reject(new CanceledError('The read was canceled.')));
            reads.push(resolve);

            return promise;
        },
    } as unknown as OpenFiles;
    const documents = new RowDocuments(openFiles);
    const path = formatDocumentPath({ engineId: 'test', viewId: 'code', fileId: 1, key: 16 }, 'Listed', '.code');
    const uri = { path, toString: () => `decomp:${path}` } as Uri;
    const textDocument = {
        uri,
        getText: () => 'class Listed',
        positionAt: (offset: number) => ({ line: 0, character: offset }),
    } as unknown as TextDocument;
    const read: ReadDocument = { text: 'class Listed', tokens: [{ start: 6, length: 6, kind: 'class', flags: 0, target: null }], locals: [] };
    let changes = 0;
    documents.onDidChangeSemanticTokens(() => changes++);
    let firstTokens: Promise<unknown> | undefined;

    await documents.searchDocuments(async () => {
        firstTokens = documents.provideDocumentSemanticTokens(textDocument);
    }, never);
    await firstTokens;
    const nextTokens = documents.provideDocumentSemanticTokens(textDocument);
    reads.at(-1)!(read);

    expect(changes).toBe(1);
    expect(((await nextTokens) as unknown as { data: number[][] }).data).toEqual([[0, 6, 6, 1, 0]]);
}, 5000);

test("a token request for the text of a partial read gets canceled once the next read came, whose tokens don't fit the text", async () => {
    const reads: ((read: ReadDocument) => void)[] = [];
    const file = { siteEngine: { manifest: { id: 'test' } }, fileId: 1 } as OpenFile;
    const openFiles = {
        files: [file],
        onDidChange: () => ({ dispose: () => undefined }),
        read() {
            const { promise, resolve } = Promise.withResolvers<ReadDocument>();
            reads.push(resolve);

            return promise;
        },
    } as unknown as OpenFiles;
    const documents = new RowDocuments(openFiles);
    const path = formatDocumentPath({ engineId: 'test', viewId: 'code', fileId: 1, key: 16 }, 'Listed', '.code');
    const uri = { path, toString: () => `decomp:${path}` } as Uri;
    const partial = 'class A\n// …';
    const textDocument = {
        uri,
        getText: () => partial,
        positionAt: (offset: number) => ({ line: 0, character: offset }),
    } as unknown as TextDocument;

    const firstText = documents.provideTextDocumentContent(uri);
    reads.at(-1)!({ text: partial, tokens: [{ start: 6, length: 1, kind: 'class', flags: 0, target: null }], locals: [], isPartial: true });
    await firstText;
    await Bun.sleep(150);
    reads.at(-1)!({ text: 'class A\n{\n    return;\n}', tokens: [{ start: 16, length: 6, kind: 'class', flags: 0, target: null }], locals: [] });
    const tokens = documents.provideDocumentSemanticTokens(textDocument);

    expect(reads).toHaveLength(2);
    await expect(tokens).rejects.toThrow();
}, 5000);
