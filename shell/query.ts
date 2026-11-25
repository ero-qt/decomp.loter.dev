import type { Row } from '#contract/rows';
import { accessibilityOf, hasModifier, type Kind, type Modifier, modifiers } from '#contract/symbols';
import { findRoot } from './candidates';

// the kinds that `kind:type` finds
const typeKinds: Kind[] = ['class', 'struct', 'interface', 'enum', 'delegate', 'record'];

/** A search's query: the text that a name or a string matches and the filters `kind:`, `is:` and `in:`. */
export interface SymbolQuery {
    /** The text that a name matches like in Go to Symbol in Workspace, or that a string has. */
    text: string;
    /** The text before a name's last dot, like `Shape` of `Shape.Area`, which the name of the row above has. */
    container: string;
    /** Whether the query searches the strings, which a quote starts. */
    isStrings: boolean;
    /** The kinds of `kind:`, like `kind:method,property`. Finds every kind when it's empty. */
    kinds: Set<string>;
    /** The accessibilities and modifiers of `is:`, like `is:public` and `is:static`, which a row has all of. */
    words: string[];
    /** The texts of `in:`, each of which a file's path or a row's top row has, or which is the file's engine. */
    places: string[];
}

/**
 * Reads a query like `kind:method is:public in:Shapes.dll Area`. A quote starts the text of a string search, which runs
 * to the end, so the filters stand before it.
 */
export function parseQuery(value: string): SymbolQuery {
    const quote = value.indexOf('"');
    const isStrings = quote >= 0 && /^(\s*(kind|is|in):\S+)*\s*$/i.test(value.slice(0, quote));
    const words = (isStrings ? value.slice(0, quote) : value).split(/\s+/).filter(Boolean);
    const query: SymbolQuery = { text: '', container: '', isStrings, kinds: new Set(), words: [], places: [] };
    const texts: string[] = [];

    for (const word of words) {
        const [, filter, values = ''] = /^(kind|is|in):(.+)$/i.exec(word) ?? [];
        const list = values.toLowerCase().split(',').filter(Boolean);
        if (filter?.toLowerCase() === 'kind') {
            list.flatMap(kind => (kind === 'type' ? typeKinds : [kind])).forEach(kind => query.kinds.add(kind));
        } else if (filter?.toLowerCase() === 'is') {
            query.words.push(...list);
        } else if (filter) {
            query.places.push(...list);
        } else {
            texts.push(word);
        }
    }

    const text = isStrings ? value.slice(quote + 1) : texts.join(' ');
    const dot = isStrings ? -1 : text.lastIndexOf('.');

    return { ...query, text: text.slice(dot + 1), container: dot < 0 ? '' : text.slice(0, dot).toLowerCase() };
}

/** Checks whether a query finds nothing because it doesn't have a text or a filter. */
export function isBlank({ text, container, kinds, words, places }: SymbolQuery): boolean {
    return text.trim() === '' && container === '' && kinds.size === 0 && words.length === 0 && places.length === 0;
}

// checks a word of `is:` against the words of a row's accessibility, like `protected` of `protected internal`, and
// against the row's modifiers
function isWord(flags: number, word: string): boolean {
    const isModifier = (modifiers as readonly string[]).includes(word) && hasModifier(flags, word as Modifier);

    return isModifier || accessibilityOf(flags).split(/[ -]/).includes(word);
}

/** Checks the `in:` filters of a query against a file's path, its engine's id and the top row above a row. */
export function isInPlace({ places }: SymbolQuery, path: string, engineId: string, rows: Row[], index: number): boolean {
    const root = index < 0 ? '' : rows[findRoot(rows, index)].name.toLowerCase();

    return places.every(place => path.toLowerCase().includes(place) || engineId.toLowerCase() === place || root.includes(place));
}

/** Checks the `kind:` and `is:` filters and the container of a query against a row. */
export function matchesRow({ kinds, words, container }: SymbolQuery, rows: Row[], index: number): boolean {
    const { kind, flags, parent } = rows[index];
    const isInContainer = container === '' || (rows[parent]?.name.toLowerCase().includes(container) ?? false);

    return isInContainer && (kinds.size === 0 || kinds.has(kind)) && words.every(word => isWord(flags, word));
}
