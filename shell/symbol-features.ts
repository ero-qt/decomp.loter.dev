import { formatTarget, parseTarget } from '#contract/document';
import type { Reference } from '#contract/engine';
import { CanceledError, EngineError } from '#contract/reply';
import { findDocumentRow, type Row } from '#contract/rows';
import type {
    CancellationToken,
    DefinitionProvider,
    DocumentSymbol,
    DocumentSymbolProvider,
    HoverProvider,
    Location,
    MarkdownString,
    Position,
    ReferenceContext,
    ReferenceProvider,
    TextDocument,
    Uri,
} from 'vscode';
import { vscode } from './api';
import { toSignal } from './cancellation';
import type { RowDocuments } from './documents';
import type { SiteEngine } from './engines';
import { type OpenFiles, type ReadDocument, readErrorText } from './files';
import { createPositionFinder } from './lines';
import { appendLoadLink } from './missing-files';
import { symbolKinds } from './rows';
import { findDeclarations, findToken } from './tokens';

// fences the code with more backticks than its longest backtick run because markdown also ends a block at a fence
// indented by 1 to 3 spaces
function appendCode(markdown: MarkdownString, code: string, language: string): MarkdownString {
    const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map(run => run.length + 1)));

    return markdown.appendMarkdown(`\n${fence}${language}\n${code}\n${fence}\n`);
}

// reads the documents of at most 50 users without places because the engine can take seconds to write each document,
// like a decompile
const maxUserDocuments = 50;

// drops an engine's refusal and a canceled call and logs any other error because the workbench then shows that it
// didn't find a result
function logCrash(error: unknown) {
    if (!(error instanceof EngineError || error instanceof CanceledError)) {
        console.error(error);
    }
}

function locateTokens(uri: Uri, { text, tokens }: ReadDocument, targets: string[]): Location[] {
    const findPosition = createPositionFinder(text);

    return tokens.filter(token => token.target !== null && targets.includes(token.target)).map(token => {
        const { line, character } = findPosition(token.start);
        const start = new vscode.Position(line, character);

        return new vscode.Location(uri, new vscode.Range(start, start.translate(0, token.length)));
    });
}

function locateRanges(uri: Uri, ranges: Int32Array): Location[] {
    const locations: Location[] = [];
    for (let index = 0; index < ranges.length; index += 3) {
        const [line, character, length] = ranges.subarray(index, index + 3);
        const start = new vscode.Position(line, character);
        locations.push(new vscode.Location(uri, new vscode.Range(start, start.translate(0, length))));
    }

    return locations;
}

function hasAncestor(rows: Row[], index: number, ancestor: number): boolean {
    for (let current = rows[index].parent; current >= 0; current = rows[current].parent) {
        if (current === ancestor) {
            return true;
        }
    }

    return false;
}

/**
 * Shows a hover for a token's symbol, goes to the symbol's declaration, lists the symbol's references and lists a
 * document's rows in the outline.
 */
export class SymbolFeatures implements HoverProvider, DefinitionProvider, ReferenceProvider, DocumentSymbolProvider {
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
        appendCode(markdown, text, language).appendText(lines.join('\n'));

        return new vscode.Hover(missingFile === null ? markdown : appendLoadLink(markdown, missingFile, found.file.picked.path), found.range);
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
            logCrash(error);

            return undefined;
        }
    }

    private async locateUses(siteEngine: SiteEngine, viewId: string, users: Reference[], targets: string[], cancellation: CancellationToken) {
        const readUris = new Set<string>();
        const references: Location[] = [];
        const signal = toSignal(cancellation);
        for (const { user, ranges } of users) {
            if (cancellation.isCancellationRequested) {
                return [];
            }

            try {
                const uri = await this.documents.findDocumentUri(siteEngine, user, viewId);
                if (uri && ranges) {
                    references.push(...locateRanges(uri, ranges));
                }
                if (!uri || ranges || readUris.has(uri.toString())) {
                    continue;
                }
                // counts the target's own document apart from the users' documents because the first user is the target
                if (readUris.size > maxUserDocuments) {
                    void vscode.window.showWarningMessage(`Showing references from the first ${maxUserDocuments} documents.`);
                    break;
                }

                readUris.add(uri.toString());
                const read = await this.documents.readAgainIfFailed(uri, logCrash, signal);
                references.push(...(read ? locateTokens(uri, read.read, targets) : []));
            } catch (error) {
                logCrash(error);
            }
        }

        return references;
    }

    // doesn't return references without `includeDeclaration` because the workbench then goes to a symbol's only use and
    // not to the peek
    async provideReferences(document: TextDocument, position: Position, context: ReferenceContext, cancellation: CancellationToken) {
        const found = context.includeDeclaration ? await this.findTarget(document, position) : undefined;
        if (!found) {
            return [];
        }
        if ('local' in found.parsed) {
            return locateTokens(document.uri, found.read, [found.target]);
        }

        try {
            const { siteEngine, viewId } = found;
            const signal = toSignal(cancellation);
            const target = ('outside' in found.parsed ? await siteEngine.engine.resolve(found.target, signal) : null) ?? found.target;
            const users = [{ user: target, ranges: null }, ...(await siteEngine.engine.findReferences(target, viewId, signal))];
            const targets = [found.target, target];
            const search = () => this.locateUses(siteEngine, viewId, users, targets, cancellation);

            return await this.documents.searchDocuments(search, cancellation);
        } catch (error) {
            logCrash(error);

            return [];
        }
    }

    // cancels the request while the workbench still has the text of the read before, like a partial document's earlier
    // part, because the read's declarations only fit its own text and the workbench requests the outline again with
    // that text
    async provideDocumentSymbols(document: TextDocument): Promise<DocumentSymbol[]> {
        const found = await this.documents.readOpenDocument(document.uri);
        if (!found) {
            return [];
        }
        if (found.read.text !== document.getText()) {
            throw new vscode.CancellationError();
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
