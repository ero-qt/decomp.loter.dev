import type { MissingFile } from '#contract/engine';
import type { Row } from '#contract/rows';
import { type Accessibility, flagsOf, type Kind, type Modifier } from '#contract/symbols';
import { maxStrings } from '../shared/limits';
import { type AddressKeys, keyTags, readAddressKeys, tagKey } from './keys';
import { splitName } from './names';

/** A function or global of a file as the glue lists it, with its address in hex. */
export interface GlueSymbol {
    addr: string;
    size: number;
    name: string;
    /** Whether other files can link the symbol, which a `static` function of C can't. */
    global: boolean;
    /** The access, like `public`, and the words `static` and `virtual` of an MSVC name, which only members have. */
    access?: 'public' | 'protected' | 'private';
    static?: boolean;
    virtual?: boolean;
}

/** An imported symbol as the glue lists it, with the library's name or the empty text for a file that leaves it out. */
export interface GlueImport {
    name: string;
    library: string;
    function: boolean;
    /** The address of the import's stub or pointer, like its entry in an ELF file's PLT, which a call goes to. */
    addr?: string;
}

/** A class from the RTTI of a file without function symbols, with the addresses of its vtables' functions. */
export interface GlueClass {
    name: string;
    methods: string[];
}

/** The symbols of a file as the glue lists them, with the debug information's struct names and the RTTI's classes. */
export interface GlueListing {
    base: string;
    functions: GlueSymbol[];
    data: GlueSymbol[];
    imports: GlueImport[];
    types: string[];
    classes: GlueClass[];
    /** The name of the PDB file in a PE file's debug directory, or the empty text. */
    pdb: string;
    hasPdb: boolean;
    /** The count of the functions and globals above the glue's cap, which the glue leaves out. */
    omitted: number;
    omittedImports: number;
    /** The count of the file's strings, of which the engine lists the first `maxStrings`. */
    strings: number;
}

/** The rows of a file with the keys of its functions and globals and the text and missing files of the file's row. */
export interface NativeRows {
    rows: Row[];
    keys: AddressKeys;
    /** The key of each import's row by the address that a call of the import goes to. */
    importKeys: Map<bigint, number>;
    /** The size of each function and global by its key, in bytes. */
    sizes: Map<number, number>;
    note: string;
    missingFiles: MissingFile[];
}

// a function or global with the scopes of its name, like `geometry`, `Rect` and `area`
interface Member {
    symbol: GlueSymbol;
    address: bigint;
    scopes: string[];
    isFunction: boolean;
}

// a namespace or class with the scopes and members inside it
interface Scope {
    name: string;
    fullName: string;
    scopes: Map<string, Scope>;
    members: Member[];
}

// the largest class that gets 1 document, in bytes of code and in methods, because the document decompiles them all
const maxClassBytes = 64 * 1024;
const maxClassMethods = 100;
// counts a method of unknown size, like a virtual method that the RTTI shows, as 1 KB, so a class of many such methods
// leaves the document to each method
const unknownMethodBytes = 1024;
// keeps each index of a key below 2^24, where the tag starts, also for the imports, which the glue caps alike
export const defaultMaxMembers = 200000;
// data whose name shows that a class exists, like `vtable for geometry::Circle`
const classData = /^(?:vtable|typeinfo|typeinfo name|VTT|construction vtable) for (.+)$/;
const operatorName = /^operator(?![A-Za-z0-9_])/;
const numberFormat = new Intl.NumberFormat('en');

function compareAddresses(first: Member, second: Member): number {
    return first.address < second.address ? -1 : first.address > second.address ? 1 : 0;
}

// lists each function of a class's vtables as `sub_<address>` inside the class, 1 function for each address, because
// the classes of a base and a derived class share the functions that the derived class doesn't override
function listVirtualMethods(classes: GlueClass[]): GlueSymbol[] {
    const symbols = new Map<string, GlueSymbol>();
    for (const { name, methods } of classes) {
        for (const addr of methods.filter(method => !symbols.has(method))) {
            symbols.set(addr, { addr, size: 0, name: `${name}::sub_${addr.slice(2)}`, global: true });
        }
    }

    return [...symbols.values()];
}

function readMembers(symbols: GlueSymbol[], isFunction: boolean): Member[] {
    return symbols.map(symbol => ({ symbol, address: BigInt(symbol.addr), scopes: splitName(symbol.name), isFunction }));
}

// drops the template arguments of a class's name, like `vector<int>` to `vector`, because its constructor's name
// doesn't have them
function withoutArguments(name: string): string {
    const start = name.indexOf('<');

    return start > 0 ? name.slice(0, start) : name;
}

// finds the classes that the names of data, constructors, destructors and MSVC members show, plus the structs of the
// debug information, whose names have a class's outer scopes or leave them out
function findClasses(data: GlueSymbol[], members: Member[], types: string[]): (fullName: string, name: string) => boolean {
    const classes = new Set<string>();
    for (const { name } of data) {
        const described = classData.exec(name)?.[1];
        const scopes = splitName(described ?? name);
        if (described !== undefined) {
            classes.add(scopes.join('::'));
        } else if (scopes.length > 1 && scopes.at(-1) === "`vftable'") {
            classes.add(scopes.slice(0, -1).join('::'));
        }
    }

    for (const { scopes, symbol } of members) {
        const [owner, name] = [scopes.at(-2), scopes.at(-1)];
        const isStructor = name === withoutArguments(owner ?? '') || name === `~${withoutArguments(owner ?? '')}`;
        if (owner !== undefined && (isStructor || symbol.access !== undefined)) {
            classes.add(scopes.slice(0, -1).join('::'));
        }
    }

    const typeNames = new Set(types);

    return (fullName, name) => classes.has(fullName) || typeNames.has(fullName) || typeNames.has(name);
}

function buildScopes(members: Member[]): Scope {
    const root: Scope = { name: '', fullName: '', scopes: new Map(), members: [] };
    for (const member of members) {
        let scope = root;
        for (const name of member.scopes.slice(0, -1)) {
            const fullName = scope === root ? name : `${scope.fullName}::${name}`;
            if (!scope.scopes.has(name)) {
                scope.scopes.set(name, { name, fullName, scopes: new Map(), members: [] });
            }

            scope = scope.scopes.get(name)!;
        }

        scope.members.push(member);
    }

    return root;
}

function listScopes(scope: Scope): Scope[] {
    return [...scope.scopes.values()].flatMap(inner => [inner, ...listScopes(inner)]);
}

// adds `Imports` with the imports by library and returns the key of each import's row by the import's address
function pushImports(rows: Row[], imports: GlueImport[], count: number): Map<bigint, number> {
    const importKeys = new Map<bigint, number>();
    if (imports.length === 0) {
        return importKeys;
    }

    const key = tagKey(keyTags.imports, 0);
    const parent = rows.push({ kind: 'section', flags: 0, parent: -1, key, name: 'Imports', detail: String(count), hiddenViews: 0 }) - 1;
    const libraries = Map.groupBy(imports.entries(), ([, { library }]) => library);
    for (const [index, library] of [...libraries.keys()].sort().entries()) {
        const libraryRow = library === '' ? parent : rows.length;
        if (library !== '') {
            rows.push({ kind: 'reference', flags: 0, parent, key: tagKey(keyTags.imports, index + 1), name: library, detail: '', hiddenViews: 0 });
        }

        for (const [importIndex, { name, function: isFunction, addr }] of libraries.get(library)!) {
            const kind = isFunction ? 'method' : 'field';
            const flags = flagsOf('public', 'extern');
            const importKey = tagKey(keyTags.importedSymbol, importIndex);
            rows.push({ kind, flags, parent: libraryRow, key: importKey, name, detail: '', hiddenViews: 0 });
            if (addr !== undefined) {
                importKeys.set(BigInt(addr), importKey);
            }
        }
    }

    return importKeys;
}

// writes the note of what the listing leaves out, like `Lists 200,000 of 312,512 functions and globals.`
function writeNote(...counts: [listed: number, count: number, what: string][]): string {
    const cuts = counts.filter(([listed, count]) => listed < count);

    return cuts.map(([listed, count, what]) => `Lists ${numberFormat.format(listed)} of ${numberFormat.format(count)} ${what}.`).join(' ');
}

/**
 * Groups the symbols that the glue lists into rows: `Imports` with the imports by library, then the namespaces and
 * classes by name with their scopes first and their functions and globals in address order. A class gets the document
 * of its methods while they're within the budget, else each method has its own document. Lists at most `maxMembers`
 * functions and globals, those with the lowest addresses.
 */
export function groupRows(listing: GlueListing, maxMembers = defaultMaxMembers): NativeRows {
    const functions = readMembers([...listing.functions, ...listVirtualMethods(listing.classes)], true);
    const functionAddresses = new Set(functions.map(member => member.address));
    const data = readMembers(listing.data, false).filter(({ address, symbol }) => !functionAddresses.has(address) && !classData.test(symbol.name));
    const isClass = findClasses(listing.data, [...functions, ...data], [...listing.types, ...listing.classes.map(({ name }) => name)]);

    const members = [...functions, ...data].sort(compareAddresses);
    const listed = members.slice(0, maxMembers);
    const importCount = listing.imports.length + listing.omittedImports;
    const note = writeNote(
        [listed.length, members.length + listing.omitted, 'functions and globals'],
        [listing.imports.length, importCount, 'imports'],
        [Math.min(listing.strings, maxStrings), listing.strings, 'strings'],
    );

    const base = BigInt(listing.base);
    const keys = readAddressKeys(listed.map(member => member.address), base);
    const root = buildScopes(listed);
    const scopes = listScopes(root);
    const classNames = scopes.filter(scope => isClass(scope.fullName, scope.name)).map(scope => scope.fullName).sort();
    const namespaceNames = scopes.filter(scope => !isClass(scope.fullName, scope.name)).map(scope => scope.fullName).sort();
    const classIndexes = new Map(classNames.map((name, index) => [name, index]));
    const namespaceIndexes = new Map(namespaceNames.map((name, index) => [name, index]));

    const rows: Row[] = [];
    const importKeys = pushImports(rows, listing.imports, importCount);

    function pushMember({ symbol, address, scopes: names, isFunction }: Member, parent: number, owner: Scope | undefined, hasDocument: boolean) {
        const name = names.at(-1)!;
        const isConstructor = owner !== undefined && name === withoutArguments(owner.name);
        const kind: Kind = !isFunction ? 'field' : isConstructor ? 'constructor' : operatorName.test(name) ? 'operator' : 'method';
        const accessibility: Accessibility = owner ? (symbol.access ?? '') : symbol.global ? 'public' : '';
        const modifiers: Modifier[] = [];
        if (owner ? !isFunction || symbol.static : !symbol.global) {
            modifiers.push('static');
        }
        if (owner && symbol.virtual) {
            modifiers.push('virtual');
        }
        if (isFunction && !hasDocument) {
            modifiers.push('document');
        }

        const detail = name === `sub_${address.toString(16)}` ? `0x${address.toString(16)}` : '';
        rows.push({ kind, flags: flagsOf(accessibility, ...modifiers), parent, key: keys.keys.get(address)!, name, detail, hiddenViews: 0 });
    }

    function pushScope(scope: Scope, parent: number, owner: Scope | undefined, hasDocument: boolean) {
        for (const inner of [...scope.scopes.values()].sort((first, second) => first.name.localeCompare(second.name))) {
            const isInnerClass = isClass(inner.fullName, inner.name);
            const methods = inner.members.filter(member => member.isFunction);
            const bytes = methods.reduce((sum, member) => sum + (member.symbol.size || unknownMethodBytes), 0);
            const hasInnerDocument = isInnerClass && methods.length <= maxClassMethods && bytes <= maxClassBytes;
            const key = isInnerClass
                ? tagKey(keyTags.class, classIndexes.get(inner.fullName)!)
                : tagKey(keyTags.namespace, namespaceIndexes.get(inner.fullName)!);
            const kind = isInnerClass ? 'class' : 'namespace';
            const flags = hasInnerDocument ? flagsOf('', 'document') : 0;
            const index = rows.push({ kind, flags, parent, key, name: inner.name, detail: '', hiddenViews: 0 }) - 1;

            pushScope(inner, index, isInnerClass ? inner : undefined, hasInnerDocument);
        }

        for (const member of scope.members.sort(compareAddresses)) {
            pushMember(member, parent, owner, hasDocument);
        }
    }

    pushScope(root, -1, undefined, false);

    const sizes = new Map(listed.map(({ address, symbol }) => [keys.keys.get(address)!, symbol.size]));

    const missingFiles = listing.pdb !== '' && !listing.hasPdb ? [{ name: listing.pdb, reason: 'not loaded', isCompanion: true }] : [];

    return { rows, keys, importKeys, sizes, note, missingFiles };
}
