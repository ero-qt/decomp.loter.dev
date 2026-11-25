import { failed, ok, type Reply } from '#contract/reply';
import type { Row } from '#contract/rows';
import { modifiersOf } from '#contract/symbols';

/** Returns the refusals that every engine gives, as failed replies whose texts have the engine's name, like `Java`. */
export function createRefusals(engineName: string) {
    const file = (fileId: number) => failed(`The ${engineName} engine doesn't have an open file with the id ${fileId}.`);

    return {
        file,
        view: (view: string) => failed(`The ${engineName} engine doesn't have the view ${view}.`),
        /** Refuses a key that the file's rows don't have, which an engine can write in its own form, like hex. */
        key: (fileName: string, key: number | string) => failed(`${fileName} doesn't have a symbol with the key ${key}.`),
        noDocument: (rowName: string) => failed(`${rowName} doesn't have its own document.`),
        largeFile: (name: string, maxBytes: number) => failed(`${name} has more than ${maxBytes / 1024 / 1024} MB, which the engine can't open.`),
        outOfMemory: (name: string) => failed(`${name} doesn't fit in the engine's memory.`),
    };
}

export type Refusals = ReturnType<typeof createRefusals>;

/**
 * Finds the row of a key for a read, which takes a row with its own document and a view of the engine, and refuses
 * the view, the key or the row otherwise.
 */
export function findDocumentRowReply(
    file: { name: string; rows: Row[] },
    key: number,
    view: string,
    views: string[],
    refusals: Refusals,
): Reply<Row> {
    const row = file.rows.find(found => found.key === key);
    if (!views.includes(view)) {
        return refusals.view(view);
    }
    if (!row) {
        return refusals.key(file.name, key);
    }
    if (!modifiersOf(row.flags).includes('document')) {
        return refusals.noDocument(row.name);
    }

    return ok(row);
}
