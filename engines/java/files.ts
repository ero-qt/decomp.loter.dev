import { failed, ok, type Reply } from '../../contract/reply';
import { type ClassSymbols, readClass, readSymbols } from './classfile';
import { openZip, type Zip, ZipError } from './zip';

/** A class of an open file with the entry that has its bytes. */
export interface JavaClass {
    entry: string;
    symbols: ClassSymbols;
}

/** An open class file or archive. */
export interface JavaFile {
    name: string;
    zip: Zip;
    /** Internal class name -> the class. */
    classes: Map<string, JavaClass>;
    /** Internal class name -> the class that contains it, for each class whose outer class the file has. */
    outers: Map<string, string>;
    /** The text on the file's row, which counts the classes that the engine leaves out. */
    note: string;
}

const listFormat = new Intl.ListFormat('en');

/** Checks whether bytes start like a class file. */
export function isClassFile(bytes: Uint8Array): boolean {
    return bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) === 0xcafebabe;
}

// leaves out the outer classes of classes that contain each other in a loop, which a hostile file can have, and walks
// from each class until a class that an earlier walk saw because each class is then visited once
function findOuters(classes: Map<string, JavaClass>): Map<string, string> {
    const outers = new Map<string, string>();
    // class name -> the class whose walk saw it first
    const walks = new Map<string, string>();

    function findOuter(name: string): string | undefined {
        const { outer } = classes.get(name)!.symbols;

        return outer !== undefined && classes.has(outer) ? outer : undefined;
    }

    for (const start of classes.keys()) {
        const walked: string[] = [];
        let name: string | undefined = start;
        for (; name !== undefined && !walks.has(name); name = findOuter(name)) {
            walks.set(name, start);
            walked.push(name);
        }

        const loop = new Set(name !== undefined && walks.get(name) === start ? walked.slice(walked.indexOf(name)) : []);
        for (const inner of walked) {
            const outer = findOuter(inner);
            if (!loop.has(inner) && outer !== undefined) {
                outers.set(inner, outer);
            }
        }
    }

    return outers;
}

/** Follows a class's outer classes up to the class that isn't nested, whose document shows every class inside it. */
export function findTop({ outers }: Pick<JavaFile, 'outers'>, name: string): string {
    let top = name;
    while (outers.has(top)) {
        top = outers.get(top)!;
    }

    return top;
}

/** Checks whether the tree shows a class, which it doesn't for a local or anonymous class or a class inside one. */
export function isShown({ classes, outers }: Pick<JavaFile, 'classes' | 'outers'>, name: string): boolean {
    for (let current: string | undefined = name; current !== undefined; current = outers.get(current)) {
        if (classes.get(current)!.symbols.isHidden) {
            return false;
        }
    }

    return true;
}

function countText(count: number, one: string, many: string): string[] {
    return count === 0 ? [] : [count === 1 ? `1 ${one}` : `${count} ${many}`];
}

// checks whether an entry's path fits its class's name, like `a/B.class` for `a/B`, also below a folder like
// `WEB-INF/classes/`, because the JVM loads a class only from such a path, and keeps a default package's class at the
// root because a folder above it looks the same as a package
function fitsPath(entry: string, name: string): boolean {
    return entry === `${name}.class` || (name.includes('/') && entry.endsWith(`/${name}.class`));
}

function isClassEntry(entry: string): boolean {
    return entry.endsWith('.class') && !entry.startsWith('META-INF/');
}

/**
 * Reads the classes of a JAR or a class file. Skips a class that the engine can't read, so 1 broken class doesn't hide
 * the others. Of entries with the same class, takes the shortest path, so the class at its name's path wins. Leaves out
 * module descriptors. Leaves out a class whose path doesn't fit its name, the classes for newer Java versions below
 * `META-INF/versions/` and nested JARs, and counts them with the skipped classes in the note. Throws once the signal
 * aborts.
 */
export async function readFile(name: string, bytes: Uint8Array, signal: AbortSignal): Promise<Reply<JavaFile>> {
    const isArchive = !isClassFile(bytes);

    let zip: Zip;
    try {
        zip = isArchive ? openZip(bytes) : { names: [name], read: async () => bytes };
    } catch (error) {
        if (error instanceof ZipError) {
            return failed(`${name}: ${error.message}`);
        }

        throw error;
    }

    const classes = new Map<string, JavaClass>();
    let firstError: unknown;
    let misplaced = 0;
    let unreadable = 0;

    for (const entry of isArchive ? zip.names.filter(isClassEntry) : zip.names) {
        signal.throwIfAborted();

        try {
            const node = readClass((await zip.read(entry))!);
            const symbols = readSymbols(node);
            const known = classes.get(symbols.name);
            if (symbols.isModule) {
                continue;
            }
            if (isArchive && !fitsPath(entry, symbols.name)) {
                misplaced++;
            } else if (!known || entry.length < known.entry.length) {
                classes.set(symbols.name, { entry, symbols });
            }
        } catch (error) {
            firstError ??= error;
            unreadable++;
        }
    }

    const outers = findOuters(classes);
    const versioned = zip.names.filter(entry => entry.startsWith('META-INF/versions/') && entry.endsWith('.class')).length;
    const nested = zip.names.filter(entry => /\.jar$/i.test(entry)).length;
    const unshown = [...classes.keys()].filter(className => !isShown({ classes, outers }, findTop({ outers }, className))).length;

    const notes = [
        ...countText(misplaced, "class whose name doesn't match its path", "classes whose names don't match their paths"),
        ...countText(unreadable, "class that the engine can't read", "classes that the engine can't read"),
        ...countText(versioned, 'class for newer Java versions', 'classes for newer Java versions'),
        ...countText(nested, 'nested JAR', 'nested JARs'),
        ...countText(unshown, 'local or anonymous class without its outer class', 'local or anonymous classes without their outer classes'),
    ];
    const note = notes.length > 0 ? `${listFormat.format(notes)} not shown` : '';

    if (classes.size === 0 && firstError !== undefined) {
        return failed(`The engine can't read ${name}: ${firstError instanceof Error ? firstError.message : String(firstError)}`);
    }
    if (classes.size === 0) {
        return failed(note ? `${name}: ${note}` : `${name} doesn't have a class file.`);
    }

    return ok({ name, zip, classes, outers, note });
}
