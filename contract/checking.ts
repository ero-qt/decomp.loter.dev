import { parseTarget } from './document';
import type { Engine } from './engine';
import { readManifest } from './manifest';
import { EngineError } from './reply';
import type { Row } from './rows';

/**
 * The files that an engine's tests open and what the tests find in the files. A row's path is the names of the rows
 * from the top down to the row, joined with dots, like `Drawing.Circle.Draw`.
 */
export interface Fixture {
    /** The engine's manifest as its JSON. */
    manifest: unknown;
    /** A file that the engine opens. */
    file: File;
    /** A file that the engine can't open. */
    broken: File;
    /** A file of a kind that the engine doesn't read. */
    foreign: File;
    /** The path of a row of `file` with its own document, which the tests read. */
    symbol: string;
    /** A string in the file. */
    string?: string;
    /** The start of a string in the file that is longer than `maxStringLength`, which the engine lists cut. */
    cutString?: string;
    /** The group of an engine whose files use symbols of other files that the engine opens. */
    linked?: {
        /**
         * A second file that the engine opens, under the name that `file` lists for the second file as a missing file.
         */
        file: File;
        /**
         * The text of a token whose symbol is in the linked file. The token is in `symbol`'s document in the first
         * view.
         */
        token: string;
        /** The path of a row of `file` whose code uses the token's symbol. */
        user: string;
        /**
         * Whether the engine can't find the file of a symbol outside the open files, like a Java class's JAR. Then
         * neither `file` nor the symbol's description lists the linked file as a missing file.
         */
        withoutMissingFile?: boolean;
    };
    /** The group of an engine that takes files through `provide`. */
    companion?: {
        /** A file that no engine claims, under the name that `file` lists for the companion as a missing file. */
        file: File;
    };
}

/** A group of fixture files that only some engines have. */
export type Group = 'linked' | 'companion';

/** A fixture that has the groups that a check needs. */
export type FixtureWith<Needed extends Group> = Fixture & Required<Pick<Fixture, Needed>>;

/** A check of 1 rule of the contract, which throws for an engine that breaks the rule with the fixture's files. */
export type Check<Needed extends Group = never> = (engine: Engine, fixture: FixtureWith<Needed>) => Promise<void>;

// file id -> the rows of the open file
export type OpenRows = Map<number, Row[]>;

/** The most rows whose documents or users a check reads. */
export const checkedRowLimit = 50;

/** A view id that no manifest has, because `readManifest` only takes lowercase letters, digits and `-` in a view id. */
export const missingView = '?';

/** Returns the id of the first view in the fixture's manifest. */
export function readFirstView({ manifest }: Fixture): string {
    return readManifest(manifest).views[0].id;
}

/** Opens the files, runs the check with their ids and closes every file that opened. */
export async function checkWithFiles(engine: Engine, files: File[], check: (...fileIds: number[]) => Promise<void>): Promise<void> {
    const fileIds: number[] = [];
    const errors: unknown[] = [];
    try {
        for (const file of files) {
            fileIds.push(await engine.open(file.name, file));
        }

        await check(...fileIds);
    } catch (error) {
        errors.push(error);
    }

    // closes every file and throws the first error because the error of a failed close would hide the check's error
    for (const fileId of fileIds) {
        await engine.close(fileId).catch((error: unknown) => errors.push(error));
    }
    if (errors.length > 0) {
        throw errors[0];
    }
}

/** Throws unless the call throws an engine error. */
export async function requireEngineError(call: Promise<unknown>, method: keyof Engine, subject: string): Promise<void> {
    const thrown = await call.catch((error: unknown) => error);
    if (!(thrown instanceof EngineError)) {
        throw new Error(`${method} doesn't throw an engine error for ${subject}`);
    }
}

/** Throws unless the target is a row target that points at 1 open row, which the engine describes. */
export async function requireRowTarget(engine: Engine, openRows: OpenRows, target: string, view: string): Promise<void> {
    const parsed = parseTarget(target);
    if (!('fileId' in parsed)) {
        throw new Error(`the target ${target} isn't a row target`);
    }

    const count = (openRows.get(parsed.fileId) ?? []).filter(row => row.key === parsed.key).length;
    if (count !== 1) {
        throw new Error(`the target ${target} points at ${count} rows`);
    }
    if ((await engine.describe(target, view)) === null) {
        throw new Error(`the engine doesn't describe the target ${target}`);
    }
}

/** Finds the row with the path and throws for a file without the row. */
export function findRow(rows: Row[], path: string, fileName: string): Row {
    const paths: string[] = [];
    for (const { name, parent } of rows) {
        paths.push(parent < 0 ? name : `${paths[parent]}.${name}`);
    }

    const row = rows[paths.indexOf(path)];
    if (!row) {
        throw new Error(`${fileName} doesn't have the row ${path}`);
    }

    return row;
}

/** Returns the lowest key that no row has. */
export function findUnusedKey(rows: Row[]): number {
    const keys = new Set(rows.map(row => row.key));
    let key = 0;
    while (keys.has(key)) {
        key++;
    }

    return key;
}
