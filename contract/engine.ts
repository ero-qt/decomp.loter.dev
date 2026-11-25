import type { Document } from './document';
import type { Rows } from './rows';

/** A file that an engine needs to show more of an open file, like a referenced assembly or a `.pdb` file. */
export interface MissingFile {
    /** The name of the missing file, with the file's extension when the file has one. */
    name: string;
    /** The other names that the file can have, like `libil2cpp.so` for a game's `GameAssembly.dll` on Android. */
    otherNames?: string[];
    /** The text that the page shows next to the name, like `1.0.0.0, not loaded`. */
    reason: string;
    /**
     * Whether `provide` takes the missing file. The page opens any other missing file in the engine that claims the
     * file.
     */
    isCompanion: boolean;
}

/** The symbols of an open file. */
export interface Listing extends Rows {
    /** The text on the file's row, like how many classes the engine leaves out. */
    note: string;
    missingFiles: MissingFile[];
}

/** The hover text of a symbol. */
export interface Description {
    /** The symbol's declaration in the language of the view. */
    text: string;
    /** The full name of the symbol that contains the symbol, like `Shapes.Shape`, or `null` at the top. */
    container: string | null;
    /** More about the symbol as pairs of a label and a value, like `token` and `0x06000012`. */
    facts: [string, string][];
    /**
     * The `name` of the `MissingFile` whose file has the symbol, or `null` for a symbol of an open file or for a symbol
     * whose file the engine can't find. The missing file is in the listing of the file whose document has the symbol's
     * token.
     */
    missingFile: string | null;
}

/** A string in an open file. */
export interface StringUse {
    text: string;
    /** The row target of the symbol whose code uses the string, or `null` for a string without a known user. */
    user: string | null;
}

/** A symbol whose code uses the symbol that `findReferences` got. */
export interface Reference {
    /** The row target of the symbol whose code uses the symbol. */
    user: string;
    /**
     * 3 values for each use in the user's code: line, character and length in the view's document of the user's
     * document row, each use inside its line, or `null` for uses without places and for a view that hides the document
     * row, so the page reads the document. Ranges without a use aren't allowed, because the page would list no use of
     * the user.
     */
    ranges: Int32Array | null;
}

/**
 * The calls of an engine, as the page makes them. A call throws an `EngineError` with a text for the user when the
 * engine refuses it, like `open` for a file that the engine can't read, and a `CanceledError` after its signal aborts.
 * Any other error is a bug or a crash, like a text that isn't a target, a worker that crashes or a `fatal` message.
 */
export interface Engine {
    /** Checks whether the engine reads a file. The engine only reads the bytes of the file that it needs for that. */
    claims(name: string, file: Blob): Promise<boolean>;
    /** Opens a file and returns the id that the other calls take. */
    open(name: string, file: Blob): Promise<number>;
    close(fileId: number): Promise<void>;
    /**
     * Adds a file that the user picked for a `MissingFile` of an open file, like a `.pdb` file. The `name` is the
     * missing file's name, which can differ from the picked file's name. The open file's listing, documents and strings
     * can change after the call.
     */
    provide(fileId: number, name: string, file: Blob): Promise<void>;
    list(fileId: number): Promise<Listing>;
    /**
     * Writes the document of a row with the `document` modifier in a view of the manifest, like the document of a type.
     * The document has a token with the `declaration` modifier and a row's target for the row and for each row whose
     * document row, see `findDocumentRow`, is the row, except a row that is hidden in the view and a method's row below
     * a property, an indexer or an event that the document declares, like a getter. The token that declares a local has
     * the `declaration` modifier. The engine refuses a key that no row has, a row that doesn't have the
     * `document` modifier, a row that is hidden in the view and a view that the manifest doesn't have.
     */
    read(fileId: number, key: number, view: string, signal?: AbortSignal): Promise<Document>;
    /**
     * Describes a symbol for a view, or returns `null` for a target that the engine doesn't have and for a local, whose
     * declaration the page shows from `Document.locals`. The engine refuses a view that the manifest doesn't have.
     */
    describe(target: string, view: string, signal?: AbortSignal): Promise<Description | null>;
    /**
     * Returns the row target of a symbol outside the open files, or `null` while no open file has the symbol. A row
     * target resolves to the same row target.
     */
    resolve(target: string, signal?: AbortSignal): Promise<string | null>;
    /**
     * Returns the symbols whose code uses a symbol, with the places of the uses in a view of the manifest. The target
     * is a row target or the target of a symbol outside the open files. The engine refuses a view that the manifest
     * doesn't have.
     */
    findReferences(target: string, view: string, signal?: AbortSignal): Promise<Reference[]>;
    listStrings(fileId: number): Promise<StringUse[]>;
}
