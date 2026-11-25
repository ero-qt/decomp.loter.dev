import type { Row } from '#contract/rows';
import { flagsOf } from '#contract/symbols';
import { findTop, isShown, type JavaFile } from './files';

/** The rows of an open file with the keys of its classes and members. */
export interface JavaRows {
    rows: Row[];
    /**
     * Internal class name or member key -> the index of the class's or member's row, which is also the row's key. A
     * record component's accessor has the index of the component's field.
     */
    keys: Map<string, number>;
    /** Row index -> the row's package as `<package>/`, its internal class name or its member key. */
    rowKeys: string[];
    /**
     * The keys of the members and classes without a row, like a lambda's method, which code shows inside another
     * member.
     */
    hiddenKeys: Set<string>;
}

// lists a class's outer classes from the top class down to the class itself
function listOuters({ outers }: JavaFile, name: string): string[] {
    const names = [name];
    while (outers.has(names[0])) {
        names.unshift(outers.get(names[0])!);
    }

    return names;
}

function findPackage(name: string): string {
    return name.slice(0, Math.max(0, name.lastIndexOf('/')));
}

/**
 * Lists the rows of the Symbols view. The packages come first as flat rows with dotted names, then the classes by name,
 * then each class's members. A nested class is below its outer class's row. A class of the default package is at the
 * top. A class that isn't nested in a class of the file has its own document.
 */
export function listRows(file: JavaFile): JavaRows {
    const rows: Row[] = [];
    const keys = new Map<string, number>();
    const hiddenKeys = new Set<string>();
    const rowKeys: string[] = [];
    // sorts by the names from the top class down because an outer class's row then comes before its nested classes'
    // rows
    const shown = [...file.classes.values()]
        .filter(({ symbols }) => isShown(file, symbols.name))
        .map(found => ({ ...found, path: listOuters(file, found.symbols.name).join('\0') }))
        .sort((first, second) => (first.path < second.path ? -1 : 1));

    function add(key: string, row: Omit<Row, 'key' | 'hiddenViews'>) {
        keys.set(key, rows.length);
        rowKeys.push(key);
        rows.push({ ...row, key: rows.length, hiddenViews: 0 });
    }

    for (const { symbols } of shown) {
        const folder = findPackage(symbols.name);
        if (!file.outers.has(symbols.name) && folder !== '' && !keys.has(`${folder}/`)) {
            add(`${folder}/`, { kind: 'namespace', flags: 0, parent: -1, name: folder.replaceAll('/', '.'), detail: '' });
        }
    }

    for (const { symbols } of shown) {
        const document = file.outers.has(symbols.name) ? 0 : flagsOf('', 'document');
        add(symbols.name, { kind: symbols.kind, flags: symbols.flags | document, parent: -1, name: symbols.shortName, detail: '' });
    }

    for (const { symbols, members } of shown) {
        const index = keys.get(symbols.name)!;
        const outer = file.outers.get(symbols.name);
        rows[index].parent = outer === undefined ? (keys.get(`${findPackage(symbols.name)}/`) ?? -1) : keys.get(outer)!;
        for (const { key, kind, flags, name, detail } of members.filter(member => !member.isHidden)) {
            add(key, { kind, flags, parent: index, name, detail });
        }
    }

    for (const { symbols, members } of file.classes.values()) {
        if (!keys.has(symbols.name) && keys.has(findTop(file, symbols.name))) {
            hiddenKeys.add(symbols.name);
        }
        for (const { key, aliasOf } of members) {
            const alias = aliasOf === undefined ? undefined : keys.get(aliasOf);
            if (alias !== undefined) {
                keys.set(key, alias);
            } else if (!keys.has(key)) {
                hiddenKeys.add(key);
            }
        }
    }

    return { rows, keys, rowKeys, hiddenKeys };
}
