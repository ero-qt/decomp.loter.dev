/** A kind of document that an engine writes for a symbol, like C# or IL. */
export interface View {
    id: string;
    /** The name on the button and in the menus that open the view. */
    title: string;
    /** The file extension of the view's documents, which also shows on their tabs. */
    extension: string;
    /** The editor language of the view's documents. */
    language: string;
}

/** The name, file extensions and views of an engine, which the page reads before it loads the engine. */
export interface Manifest {
    /** The engine's folder name on the site. */
    id: string;
    name: string;
    /** The extensions of the files that the engine reads, for the file dialog. */
    extensions: string[];
    /**
     * The first bytes of the files that the engine reads, each in lowercase hex digits, like `7f454c46`. A file whose
     * name has none of the extensions goes to the engine's `claims` when the file starts with one of the magics.
     */
    magics?: string[];
    /** The views of a symbol. A click on a symbol opens the first view. */
    views: View[];
    /** Whether a file's results depend on the other open files, like an assembly that references another assembly. */
    hasLinkedFiles?: boolean;
    /**
     * Whether a file of the engine keeps a companion that it gets to itself, like a game's binary, whose code the
     * IL2CPP engine opens for the game. The companion then doesn't open as its own file in the engine that claims it,
     * and the page opens the engine's files first, so a companion among the picked files goes to them.
     */
    keepsCompanions?: boolean;
    /** The size in bytes of the worker's wasm memory above which the page stops the worker after a call. */
    memoryLimitBytes?: number;
    /**
     * The milliseconds that a canceled call may block the next call before the page restarts the worker, for an engine
     * whose call can't stop in the middle, like a decompile. The page's own limit applies without it.
     */
    cancelLimitMs?: number;
    /**
     * Whether the engine replies to `describe` and `resolve` while a `read` waits, like an engine whose read waits for
     * decompiles in the background, so a hover doesn't wait for the read.
     */
    repliesDuringReads?: boolean;
    /** The rank of the engine in the page's search for an engine that claims a file, higher first, 0 by default. */
    priority?: number;
    /** The text of the engine's row in the About tab's table of supported files, like `Java classes and archives`. */
    formats?: string;
    /** The text after the extensions in that row, like `and files without an extension`. */
    fileNote?: string;
}

/** The most bytes that a magic has. */
export const maxMagicBytes = 16;

const magicPattern = new RegExp(`^([0-9a-f]{2}){1,${maxMagicBytes}}$`);

// keeps each view's bit in a row's `hiddenViews` below the sign bit of a 32-bit number
const maxViews = 31;

function readObject(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${name} isn't an object`);
    }

    return value as Record<string, unknown>;
}

function readString(value: unknown, name: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${name} isn't a string`);
    }

    return value;
}

function readOptionalString(value: unknown, name: string): string | undefined {
    return value === undefined ? undefined : readString(value, name);
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
    if (value !== undefined && typeof value !== 'boolean') {
        throw new Error(`${name} isn't a boolean`);
    }

    return value;
}

function readOptionalPositiveInteger(value: unknown, name: string): number | undefined {
    if (value !== undefined && !(Number.isSafeInteger(value) && (value as number) > 0)) {
        throw new Error(`${name} isn't a positive whole number`);
    }

    return value as number | undefined;
}

function readOptionalInteger(value: unknown, name: string): number | undefined {
    if (value !== undefined && !Number.isSafeInteger(value)) {
        throw new Error(`${name} isn't a whole number`);
    }

    return value as number | undefined;
}

function readExtension(value: unknown, name: string): string {
    const extension = readString(value, name);
    if (!extension.startsWith('.')) {
        throw new Error(`the extension '${extension}' doesn't start with a dot`);
    }

    return extension;
}

function readList(value: unknown, name: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${name} isn't a list`);
    }

    return value;
}

function readMagic(value: unknown, index: number): string {
    const magic = readString(value, `magic ${index}`);
    if (!magicPattern.test(magic)) {
        throw new Error(`the magic '${magic}' isn't 1 to ${maxMagicBytes} bytes in lowercase hex digits`);
    }

    return magic;
}

function readId(value: unknown, name: string): string {
    const id = readString(value, name);
    if (!/^[a-z0-9-]+$/.test(id)) {
        throw new Error(`${name} '${id}' has other characters than a-z, 0-9 and -`);
    }

    return id;
}

function refuseUnknownKeys(value: Record<string, unknown>, keys: readonly string[], name: string) {
    const unknownKey = Object.keys(value).find(key => !keys.includes(key));
    if (unknownKey !== undefined) {
        throw new Error(`${name} has the unknown key '${unknownKey}'`);
    }
}

const viewKeys = ['id', 'title', 'extension', 'language'] as const satisfies readonly (keyof View)[];

const manifestKeys = [
    'id',
    'name',
    'extensions',
    'magics',
    'views',
    'hasLinkedFiles',
    'keepsCompanions',
    'memoryLimitBytes',
    'cancelLimitMs',
    'repliesDuringReads',
    'priority',
    'formats',
    'fileNote',
] as const satisfies readonly (keyof Manifest)[];

function readView(value: unknown, index: number): View {
    const view = readObject(value, `view ${index}`);
    refuseUnknownKeys(view, viewKeys, `view ${index}`);

    return {
        id: readId(view.id, `the id of view ${index}`),
        title: readString(view.title, `the title of view ${index}`),
        extension: readExtension(view.extension, `the extension of view ${index}`),
        language: readString(view.language, `the language of view ${index}`),
    };
}

function refuseSameInViews(views: View[], key: 'id' | 'extension') {
    const values = views.map(view => view[key]);
    const twice = values.find((value, index) => values.indexOf(value) !== index);
    if (twice !== undefined) {
        throw new Error(`2 views have the ${key} '${twice}'`);
    }
}

/** Reads the manifest of an engine from its JSON and throws for a manifest that breaks a rule. */
export function readManifest(value: unknown): Manifest {
    const manifest = readObject(value, 'the manifest');
    refuseUnknownKeys(manifest, manifestKeys, 'the manifest');
    const id = readId(manifest.id, 'the id');
    const views = readList(manifest.views, 'the views').map(readView);
    if (views.length === 0) {
        throw new Error("the manifest doesn't have a view");
    }
    if (views.length > maxViews) {
        throw new Error(`the manifest has more than ${maxViews} views`);
    }

    refuseSameInViews(views, 'id');
    refuseSameInViews(views, 'extension');

    return {
        id,
        name: readString(manifest.name, 'the name'),
        extensions: readList(manifest.extensions, 'the extensions').map((extension, index) => {
            return readExtension(extension, `extension ${index}`);
        }),
        magics: manifest.magics === undefined ? undefined : readList(manifest.magics, 'the magics').map(readMagic),
        views,
        hasLinkedFiles: readOptionalBoolean(manifest.hasLinkedFiles, 'hasLinkedFiles'),
        keepsCompanions: readOptionalBoolean(manifest.keepsCompanions, 'keepsCompanions'),
        memoryLimitBytes: readOptionalPositiveInteger(manifest.memoryLimitBytes, 'memoryLimitBytes'),
        cancelLimitMs: readOptionalPositiveInteger(manifest.cancelLimitMs, 'cancelLimitMs'),
        repliesDuringReads: readOptionalBoolean(manifest.repliesDuringReads, 'repliesDuringReads'),
        priority: readOptionalInteger(manifest.priority, 'priority'),
        formats: readOptionalString(manifest.formats, 'formats'),
        fileNote: readOptionalString(manifest.fileNote, 'fileNote'),
    };
}

/** Reads the first bytes of a file, as many as the longest magic can have. */
export async function readStart(file: Blob): Promise<Uint8Array> {
    return new Uint8Array(await file.slice(0, maxMagicBytes).arrayBuffer());
}

/** Writes bytes as hex without Node's `Buffer`, which a browser's worker doesn't have. */
export function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Returns whether the file's name ends with one of the manifest's extensions without case or the file's start begins
 * with one of the manifest's magics.
 */
export function matchesFile(manifest: Manifest, name: string, start: Uint8Array): boolean {
    const lowerName = name.toLowerCase();
    const startHex = toHex(start);

    return (
        manifest.extensions.some(extension => lowerName.endsWith(extension.toLowerCase()))
        || (manifest.magics ?? []).some(magic => startHex.startsWith(magic))
    );
}
