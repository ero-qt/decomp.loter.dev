import type {
    CancellationToken,
    DefinitionProvider,
    DocumentSymbol,
    DocumentSymbolProvider,
    HoverProvider,
    MarkdownString,
    Position,
    TextDocument,
} from 'vscode';
import { formatTarget, parseTarget } from '../contract/document';
import { CanceledError, EngineError } from '../contract/reply';
import { findDocumentRow, type Row } from '../contract/rows';
import { vscode } from './api';
import { toSignal } from './cancellation';
import type { RowDocuments } from './documents';
import { type OpenFiles, readErrorText } from './files';
import { symbolKinds } from './rows';
import { findDeclarations, findToken } from './tokens';

// fences the code with more backticks than its longest backtick run because markdown also ends a block at a fence
// indented by 1 to 3 spaces
function appendCode(markdown: MarkdownString, code: string, language: string): MarkdownString {
    const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map(run => run.length + 1)));

    return markdown.appendMarkdown(`\n${fence}${language}\n${code}\n${fence}\n`);
}

function hasAncestor(rows: Row[], index: number, ancestor: number): boolean {
    for (let current = rows[index].parent; current >= 0; current = rows[current].parent) {
        if (current === ancestor) {
            return true;
        }
    }

    return false;
}

/** Shows a hover for a token's symbol, goes to the symbol's declaration and lists a document's rows in the outline. */
export class SymbolFeatures implements HoverProvider, DefinitionProvider, DocumentSymbolProvider {
    constructor(private readonly openFiles: OpenFiles, private readonly documents: RowDocuments) {}

    private async findTarget(document: TextDocument, position: Position) {
        const found = await this.documents.readOpenDocument(document.uri);
        const token = found && findToken(found.read.tokens, document.offsetAt(position));
        if (!found || !token?.target) {
            return undefined;
        }

        const range = new vscode.Range(document.positionAt(token.start), document.positionAt(token.start + token.length));

        return { ...found, siteEngine: found.file.siteEngine!, target: token.target, parsed: parseTarget(token.target), range };
    }

    async provideHover(document: TextDocument, position: Position, cancellation: CancellationToken) {
        const found = await this.findTarget(document, position);
        if (!found) {
            return undefined;
        }

        const { language } = found.siteEngine.manifest.views.find(view => view.id === found.viewId)!;
        const markdown = new vscode.MarkdownString();
        if ('local' in found.parsed) {
            return new vscode.Hover(appendCode(markdown, found.read.locals[found.parsed.local], language), found.range);
        }

        const signal = toSignal(cancellation);
        const description = await found.siteEngine.engine.describe(found.target, found.viewId, signal).catch((error: unknown) => {
            return error instanceof CanceledError ? null : readErrorText(error, 'The engine crashed while it described the symbol.');
        });
        if (typeof description === 'string') {
            return new vscode.Hover(markdown.appendText(description), found.range);
        }
        if (!description) {
            return undefined;
        }

        const { text, container, facts, missingFile } = description;
        const lines = [
            ...(container === null ? [] : [`in ${container}`]),
            ...facts.map(([label, value]) => `${label} ${value}`),
            ...(missingFile === null ? [] : [`${missingFile} isn't loaded.`]),
        ];

        return new vscode.Hover(appendCode(markdown, text, language).appendText(lines.join('\n')), found.range);
    }

    async provideDefinition(document: TextDocument, position: Position, cancellation: CancellationToken) {
        const found = await this.findTarget(document, position);
        if (!found) {
            return undefined;
        }
        if ('local' in found.parsed) {
            const declaration = findDeclarations(found.read.tokens).get(found.target);

            const start = declaration && document.positionAt(declaration.start);

            return start && new vscode.Location(document.uri, new vscode.Range(start, start.translate(0, declaration.length)));
        }

        try {
            const { engine } = found.siteEngine;
            const target = 'outside' in found.parsed ? await engine.resolve(found.target, toSignal(cancellation)) : found.target;
            const located = target === null ? undefined : await this.documents.locate(found.siteEngine, target, found.viewId);

            return located && new vscode.Location(located.uri, located.range);
        } catch (error) {
            // drops an engine's refusal and logs any other error because the workbench then shows that it didn't find a
            // definition
            if (!(error instanceof EngineError)) {
                console.error(error);
            }

            return undefined;
        }
    }

    async provideDocumentSymbols(document: TextDocument): Promise<DocumentSymbol[]> {
        const found = await this.documents.readOpenDocument(document.uri);
        if (!found) {
            return [];
        }

        const { rows } = await this.openFiles.list(found.file);
        const documentIndex = rows.findIndex(row => row.key === found.key);
        const declarations = findDeclarations(found.read.tokens);
        const shownRows = rows.flatMap((row, index) => {
            const declaration = declarations.get(formatTarget({ fileId: found.file.fileId!, key: row.key }));

            return declaration && findDocumentRow(rows, index) === documentIndex ? [{ row, index, declaration }] : [];
        });
        const topSymbols: DocumentSymbol[] = [];
        // the symbols whose range ends at a later declaration, each one inside the symbol before it
        const openSymbols: { index: number; symbol: DocumentSymbol }[] = [];

        function closeSymbols(isClosed: (index: number) => boolean, endLine: number) {
            while (openSymbols.length > 0 && isClosed(openSymbols.at(-1)!.index)) {
                const { symbol } = openSymbols.pop()!;
                symbol.range = new vscode.Range(symbol.range.start, document.lineAt(Math.max(endLine, symbol.range.start.line)).range.end);
            }
        }

        for (const { row, index, declaration } of shownRows.sort((first, second) => first.declaration.start - second.declaration.start)) {
            const start = document.positionAt(declaration.start);
            const selection = new vscode.Range(start, start.translate(0, declaration.length));
            const kind = vscode.SymbolKind[symbolKinds[row.kind]];
            const symbol = new vscode.DocumentSymbol(row.name, row.detail, kind, document.lineAt(start.line).range, selection);
            closeSymbols(open => !hasAncestor(rows, index, open), start.line - 1);
            (openSymbols.at(-1)?.symbol.children ?? topSymbols).push(symbol);
            openSymbols.push({ index, symbol });
        }

        closeSymbols(() => true, document.lineCount - 1);

        return topSymbols;
    }
}
