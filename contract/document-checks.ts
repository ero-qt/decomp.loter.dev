import {
    checkedRowLimit,
    checkWithFiles,
    findRow,
    findUnusedKey,
    type Fixture,
    missingView,
    type OpenRows,
    requireEngineError,
    requireRowTarget,
} from './checking';
import { formatTarget, parseTarget, readTokens, type Token } from './document';
import type { Engine } from './engine';
import { readManifest } from './manifest';
import { findDocumentRow, readRows, type Row } from './rows';
import { modifiersOf } from './symbols';

function hasDeclaration(tokens: Token[], target: string): boolean {
    return tokens.some(token => token.target === target && modifiersOf(token.flags).includes('declaration'));
}

function requireDeclaration(tokens: Token[], target: string, subject: string) {
    if (!hasDeclaration(tokens, target)) {
        throw new Error(`${subject} doesn't have a declaration token with the target ${target}`);
    }
}

function isHiddenIn({ hiddenViews }: Row, viewIndex: number): boolean {
    return (hiddenViews & (1 << viewIndex)) !== 0;
}

function describeDocument(rows: Row[], documentIndex: number, view: string): string {
    return `the document of ${rows[documentIndex].name} in the view ${view}`;
}

async function requireOwnDocuments(engine: Engine, fileId: number, rows: Row[], indexes: number[], view: string): Promise<void> {
    for (const { key, name, flags } of indexes.map(index => rows[index])) {
        if (!modifiersOf(flags).includes('document')) {
            await requireEngineError(engine.read(fileId, key, view), 'read', `${name}, which doesn't have its own document`);
        }
    }
}

/**
 * Reads the document of each row's document row in a view once and checks that `read` throws an engine error for a
 * document row that is hidden in the view. Returns the tokens of each document by the document row's index.
 */
async function readDocuments(
    engine: Engine,
    fileId: number,
    rows: Row[],
    indexes: number[],
    view: string,
    viewIndex: number,
): Promise<Map<number, Token[]>> {
    const documents = new Map<number, Token[]>();
    for (const documentIndex of new Set(indexes.map(index => findDocumentRow(rows, index)))) {
        if (documentIndex === undefined) {
            continue;
        }

        const { key, name } = rows[documentIndex];
        if (isHiddenIn(rows[documentIndex], viewIndex)) {
            await requireEngineError(engine.read(fileId, key, view), 'read', `${name}, which is hidden in the view ${view}`);
            continue;
        }

        documents.set(documentIndex, readTokens(await engine.read(fileId, key, view)));
    }

    return documents;
}

/**
 * Checks that the document of each row's document row declares the row in a view exactly when the view doesn't hide the
 * row and that each document declares each of its locals.
 */
function requireDeclarations(fileId: number, rows: Row[], indexes: number[], documents: Map<number, Token[]>, view: string, viewIndex: number) {
    for (const index of indexes) {
        const documentIndex = findDocumentRow(rows, index);
        const tokens = documentIndex === undefined ? undefined : documents.get(documentIndex);
        if (documentIndex === undefined || !tokens) {
            continue;
        }

        const target = formatTarget({ fileId, key: rows[index].key });
        const subject = describeDocument(rows, documentIndex, view);
        if (!isHiddenIn(rows[index], viewIndex)) {
            requireDeclaration(tokens, target, subject);
        } else if (hasDeclaration(tokens, target)) {
            throw new Error(`${subject} has a declaration token with the target ${target}, whose row is hidden in the view`);
        }
    }

    for (const [documentIndex, tokens] of documents) {
        for (const { target } of tokens) {
            if (target !== null && 'local' in parseTarget(target)) {
                requireDeclaration(tokens, target, describeDocument(rows, documentIndex, view));
            }
        }
    }
}

// picks up to `count` of the indexes spread over the list, the first index first
function spread(indexes: number[], count: number): number[] {
    const picked = Math.min(count, indexes.length);

    return Array.from({ length: picked }, (_, step) => indexes[Math.floor((step * indexes.length) / picked)]);
}

/**
 * Picks the indexes of `limit` rows, or of every row of a file with fewer rows, for the document checks, in the rows'
 * order: the first row of each combination of kind, hidden views and the `document` modifier, then the first rows of
 * the document rows that no picked row is in, spread over the whole file, then other rows spread over the whole file.
 */
export function pickRows(rows: Row[], limit: number): number[] {
    const picked = new Set<number>();
    const combinations = new Set<string>();
    for (const [index, { kind, flags, hiddenViews }] of rows.entries()) {
        const combination = `${kind} ${hiddenViews} ${modifiersOf(flags).includes('document')}`;
        if (!combinations.has(combination) && picked.size < limit) {
            combinations.add(combination);
            picked.add(index);
        }
    }

    const coveredDocuments = new Set([...picked].map(index => findDocumentRow(rows, index)));
    const uncovered: number[] = [];
    for (const index of rows.keys()) {
        const documentIndex = findDocumentRow(rows, index);
        if (documentIndex !== undefined && !coveredDocuments.has(documentIndex)) {
            coveredDocuments.add(documentIndex);
            uncovered.push(index);
        }
    }

    for (const index of spread(uncovered, limit - picked.size)) {
        picked.add(index);
    }
    for (const index of spread([...rows.keys()].filter(index => !picked.has(index)), limit - picked.size)) {
        picked.add(index);
    }

    return [...picked].sort((first, second) => first - second);
}

function refuseHiddenViews(rows: Row[], viewCount: number) {
    const allViews = 2 ** viewCount - 1;
    for (const { name, hiddenViews } of rows) {
        if (hiddenViews < 0 || hiddenViews > allViews) {
            throw new Error(`the row ${name} is hidden in a view that the manifest doesn't have`);
        }
        if (hiddenViews === allViews) {
            throw new Error(`the row ${name} is hidden in every view`);
        }
    }
}

/**
 * Checks the documents of the fixture's symbol and of up to 50 rows of `pickRows` in every view. No row is hidden in
 * every view or in a view that the manifest doesn't have. `read` throws an engine error for each of the rows without
 * the `document` modifier and for a document row that is hidden in the view. `readTokens` accepts each document, the
 * document of each row's document row has the row's declaration exactly when the view doesn't hide the row, each
 * document has the declaration of each of its locals and each row target points at 1 row that the engine describes. The
 * engine doesn't describe a local or a row target that doesn't point at a row. The symbol's row target resolves to the
 * same target. `read` and `describe` throw an engine error for a view that the manifest doesn't have, and `read` also
 * for a key that no row has.
 */
export async function checkDocuments(engine: Engine, { manifest, file, symbol }: Fixture): Promise<void> {
    await checkWithFiles(engine, [file], async fileId => {
        const rows = readRows(await engine.list(fileId));
        const openRows: OpenRows = new Map([[fileId, rows]]);
        const symbolRow = findRow(rows, symbol, file.name);
        const indexes = [...new Set([rows.indexOf(symbolRow), ...pickRows(rows, checkedRowLimit)])];
        const unusedKey = findUnusedKey(rows);
        const rowlessTarget = formatTarget({ fileId, key: unusedKey });
        const { views } = readManifest(manifest);
        refuseHiddenViews(rows, views.length);
        for (const [viewIndex, { id }] of views.entries()) {
            await requireOwnDocuments(engine, fileId, rows, indexes, id);
            const documents = await readDocuments(engine, fileId, rows, indexes, id, viewIndex);
            requireDeclarations(fileId, rows, indexes, documents, id, viewIndex);
            const tokens = [...documents.values()].flat();
            for (const target of new Set(tokens.flatMap(token => (token.target === null ? [] : [token.target])))) {
                const parsed = parseTarget(target);
                if ('fileId' in parsed) {
                    await requireRowTarget(engine, openRows, target, id);
                } else if ('local' in parsed && (await engine.describe(target, id)) !== null) {
                    throw new Error(`the engine describes the local ${target}`);
                }
            }

            if ((await engine.describe(rowlessTarget, id)) !== null) {
                throw new Error(`the engine describes the target ${rowlessTarget}, which doesn't point at a row`);
            }

            await requireEngineError(engine.read(fileId, unusedKey, id), 'read', 'a key that no row has');
        }

        const symbolTarget = formatTarget({ fileId, key: symbolRow.key });
        if ((await engine.resolve(symbolTarget)) !== symbolTarget) {
            throw new Error(`the row target ${symbolTarget} doesn't resolve to the same target`);
        }

        await requireEngineError(engine.read(fileId, symbolRow.key, missingView), 'read', "a view that the manifest doesn't have");
        await requireEngineError(engine.describe(symbolTarget, missingView), 'describe', "a view that the manifest doesn't have");
    });
}
