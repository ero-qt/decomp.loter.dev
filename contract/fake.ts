import { type Document, formatTarget, parseTarget, type Token, writeTokens } from './document';
import type { Description, MissingFile, Reference } from './engine';
import { type Manifest, readManifest } from './manifest';
import { failed, ok, type Reply } from './reply';
import { type Row, writeRows } from './rows';
import type { EngineHandlers } from './serve';
import { accessibilities, accessibilityOf, flagsOf, type Kind, kinds, modifiers, modifiersOf } from './symbols';

export const fakeManifest: Manifest = readManifest({
    id: 'fake',
    name: 'Fake',
    extensions: ['.fake'],
    views: [
        { id: 'code', title: 'Code', extension: '.code', language: 'plaintext' },
        { id: 'ops', title: 'Ops', extension: '.ops', language: 'plaintext' },
    ],
    hasLinkedFiles: true,
});

const firstLine = 'fake';
// the bit of the view `code`, the manifest's first view
const hiddenInCode = 1;

/** 2 fake files, where `drawing.fake` uses a symbol of `shapes.fake` and needs the companion `drawing.notes`. */
export const sampleFiles = {
    drawing: new File([`fake
needs drawing.notes
note 1 class left out
string drawing 1.0
namespace Drawing
 public sealed class Circle
  private readonly field radius
  public constructor Circle
   uses drawing.fake|Drawing.Circle.radius
  public method Draw
   var area
   uses shapes.fake|Shapes.Shape.Area
   string circle
  private enum Color
   public const enum_member Red = 1
`], 'drawing.fake'),
    shapes: new File([`fake
namespace Shapes
 public abstract class Shape
  public abstract method Area
`], 'shapes.fake'),
};

const codeWords = ['var', 'uses', 'string'] as const;

interface Line {
    depth: number;
    /** The index of the line's row or of the row whose code has the line, or -1 for a line of code at the top. */
    row: number;
    /** The first word of a line of code, or `''` for a line that is a row. */
    word: '' | (typeof codeWords)[number];
    text: string;
}

interface FakeFile {
    name: string;
    note: string;
    rows: Row[];
    /**
     * The name of each row after the names of the rows that contain the row, joined with dots, like
     * `Drawing.Circle.Draw`.
     */
    paths: string[];
    lines: Line[];
    /** The names of the file's companions that `provide` hasn't got yet. */
    neededNames: Set<string>;
    /** The names of the file's companions that `provide` got. */
    providedNames: string[];
}

function isOneOf<Item extends string>(items: readonly Item[], word: string): word is Item {
    return (items as readonly string[]).includes(word);
}

// hides a row in every view that hides the row's parent because a row can't show in a view without its parent
function parseRow(lineWords: string[], parent: number, key: number, parentHiddenViews: number): Row | undefined {
    const isHidden = lineWords[0] === 'hidden';
    const words = isHidden ? lineWords.slice(1) : lineWords;
    const kindIndex = words.findIndex(word => isOneOf(kinds, word));
    const before = words.slice(0, Math.max(kindIndex, 0));
    const [kind, name, ...detail] = words.slice(before.length);
    // tries 2 words before 1 word because the accessibility `private protected` starts with the accessibility `private`
    const starts = [2, 1].map(count => before.slice(0, count).join(' '));
    const accessibility = starts.find(start => isOneOf(accessibilities, start)) ?? '';
    const rowModifiers = before.slice(accessibility === '' ? 0 : accessibility.split(' ').length);
    if (!isOneOf(kinds, kind) || name === undefined || !rowModifiers.every(word => isOneOf(modifiers, word))) {
        return undefined;
    }

    const hiddenViews = (isHidden ? hiddenInCode : 0) | parentHiddenViews;

    return { kind, flags: flagsOf(accessibility, ...rowModifiers), parent, key, name, detail: detail.join(' '), hiddenViews };
}

function parseFile(name: string, fileText: string): Reply<FakeFile> {
    const [first, ...written] = fileText.split(/\r?\n/);
    if (first !== firstLine) {
        return failed(`${name} isn't a fake file.`);
    }

    const file: FakeFile = { name, note: '', rows: [], paths: [], lines: [], neededNames: new Set(), providedNames: [] };
    // depth -> the index of the last row at the depth
    const rowAtDepth: number[] = [];
    for (const line of written.filter(line => line.trim() !== '')) {
        const depth = line.search(/\S/);
        const [word, ...words] = line.trim().split(' ');
        const text = words.join(' ');
        const parent: number | undefined = depth === 0 ? -1 : rowAtDepth[depth - 1];
        const parentHiddenViews = file.rows[parent ?? -1]?.hiddenViews ?? 0;
        const row = parent === undefined ? undefined : parseRow([word, ...words], parent, file.rows.length + 1, parentHiddenViews);
        if (word === 'note' && depth === 0) {
            file.note = text;
        } else if (word === 'needs' && depth === 0) {
            file.neededNames.add(text);
        } else if (parent !== undefined && isOneOf(codeWords, word) && (word !== 'uses' || text.includes('|'))) {
            file.lines.push({ depth, row: parent, word, text });
        } else if (row) {
            rowAtDepth.splice(depth, Infinity, file.rows.length);
            file.lines.push({ depth, row: file.rows.length, word: '', text: '' });
            file.paths.push(row.parent < 0 ? row.name : `${file.paths[row.parent]}.${row.name}`);
            file.rows.push(row);
        } else {
            return failed(`The fake engine can't read the line '${line.trim()}' of ${name}.`);
        }
    }

    return ok(file);
}

// gives a row at the top or below a namespace its own document, except a namespace or a section, because a nested type
// is in the outer type's document
function hasDocument({ rows }: FakeFile, { kind, parent }: Row): boolean {
    return kind !== 'namespace' && kind !== 'section' && (parent < 0 || rows[parent].kind === 'namespace');
}

function hasView(view: string): boolean {
    return fakeManifest.views.some(({ id }) => id === view);
}

function isHidden({ hiddenViews }: Row, view: string): boolean {
    return (hiddenViews & (1 << fakeManifest.views.findIndex(({ id }) => id === view))) !== 0;
}

// lists the lines of a row's document in a view, which are the document's text lines in order
function listDocumentLines(file: FakeFile, root: number, view: string): Line[] {
    const first = file.lines.findIndex(line => line.word === '' && line.row === root);
    const end = file.lines.findIndex((line, index) => index > first && line.depth <= file.lines[first].depth);

    return file.lines.slice(first, end < 0 ? undefined : end).filter(line => !isHidden(file.rows[line.row], view));
}

function findDocumentIndex(file: FakeFile, index: number): number | undefined {
    let current = index;
    while (current >= 0 && !hasDocument(file, file.rows[current])) {
        current = file.rows[current].parent;
    }

    return current < 0 ? undefined : current;
}

function writeDeclaration({ kind, flags, name, detail }: Row, view: string): [before: string, name: string, after: string] {
    const words = [accessibilityOf(flags), ...modifiersOf(flags), kind].filter(word => word !== '');

    // starts the declaration with a dot in the view `ops` because the 2 views then have different texts
    return [`${view === 'ops' ? '.' : ''}${words.join(' ')} `, name, detail && ` ${detail}`];
}

/**
 * Returns the handlers of an engine for tests, which keeps the open files in memory. A fake file starts with the line
 * `fake`. A symbol's line is `[hidden] [accessibility] [modifiers] <kind> <name> [detail]` and has 1 more space before
 * it than the line of the symbol that contains it. The view `code` leaves out a `hidden` symbol's lines and the lines
 * below them. At the top, `note <text>` is the text on the file's row and `needs <name>` is a missing companion file
 * that `provide` takes, after which each document of the file ends with the line `notes <name>`. Inside a symbol,
 * `var <name>` is a local, `string <text>` is a string and `uses <file>|<path>` is a used symbol like
 * `shapes.fake|Shapes.Shape.Area`. A used symbol has the target `|<file>|<path>` and lists the file as a missing file
 * while the file isn't open.
 */
export function createFakeHandlers(): EngineHandlers {
    const files = new Map<number, FakeFile>();

    function handleFile<Value>(fileId: number, handle: (file: FakeFile) => Reply<Value>): Reply<Value> {
        const file = files.get(fileId);

        return file ? handle(file) : failed(`The fake engine doesn't have an open file with the id ${fileId}.`);
    }

    function findTargetRow(target: string): { file: FakeFile; row: Row; target: string } | undefined {
        const parsed = parseTarget(target);
        for (const [fileId, file] of files) {
            let index = -1;
            if ('fileId' in parsed && parsed.fileId === fileId) {
                index = parsed.key - 1;
            } else if ('outside' in parsed && parsed.outside.startsWith(`${file.name}|`)) {
                index = file.paths.indexOf(parsed.outside.slice(file.name.length + 1));
            }
            if (file.rows[index]) {
                return { file, row: file.rows[index], target: formatTarget({ fileId, key: index + 1 }) };
            }
        }

        return undefined;
    }

    function isUse(line: Line, used: string): boolean {
        const outside = formatTarget({ outside: line.text });

        return line.word === 'uses' && (findTargetRow(outside)?.target ?? outside) === used;
    }

    // only places the uses in the view `ops` because the tests then cover a reply with places and a reply without them
    function placeUses(file: FakeFile, user: number, used: string, view: string): Int32Array | null {
        const root = findDocumentIndex(file, user);
        if (view !== 'ops' || root === undefined || isHidden(file.rows[root], view)) {
            return null;
        }

        const lines = listDocumentLines(file, root, view);

        return new Int32Array(lines.flatMap((line, index) => {
            const indent = 4 * (line.depth - lines[0].depth);

            return line.row === user && isUse(line, used) ? [index, indent + 'uses '.length, line.text.split('|')[1].length] : [];
        }));
    }

    function formatUser(fileId: number, file: FakeFile, { row }: Line): string | null {
        return row < 0 ? null : formatTarget({ fileId, key: file.rows[row].key });
    }

    function listMissingFiles(file: FakeFile): MissingFile[] {
        const openNames = [...files.values()].map(open => open.name);
        const usedNames = file.lines.filter(line => line.word === 'uses').map(line => line.text.split('|')[0]);
        const missingNames = new Set([...file.neededNames, ...usedNames.filter(name => !openNames.includes(name))]);

        return [...missingNames].map(name => ({ name, reason: 'not loaded', isCompanion: file.neededNames.has(name) }));
    }

    function writeDocument(fileId: number, file: FakeFile, root: number, view: string): Document {
        const lines = listDocumentLines(file, root, view);
        const tokens: Token[] = [];
        const locals: string[] = [];
        let text = '';

        function write(part: string, kind?: Kind, flags = 0, target: string | null = null) {
            if (kind) {
                tokens.push({ start: text.length, length: part.length, kind, flags, target });
            }

            text += part;
        }

        for (const line of lines) {
            const row = file.rows[line.row];
            write('    '.repeat(line.depth - lines[0].depth));
            if (line.word === '') {
                const [before, name, after] = writeDeclaration(row, view);
                write(before);
                write(name, row.kind, row.flags | flagsOf('', 'declaration'), formatTarget({ fileId, key: row.key }));
                write(after);
            } else {
                write(line.word, view === 'ops' ? 'opcode' : undefined);
                write(' ');
            }
            if (line.word === 'var') {
                write(line.text, 'local', flagsOf('', 'declaration'), formatTarget({ local: locals.push(`var ${line.text}`) - 1 }));
            } else if (line.word === 'uses') {
                const outside = formatTarget({ outside: line.text });
                const used = findTargetRow(outside);
                write(line.text.split('|')[1], used?.row.kind ?? 'method', used?.row.flags, used?.target ?? outside);
            } else if (line.word === 'string') {
                write(JSON.stringify(line.text));
            }

            write('\n');
        }
        for (const name of file.providedNames) {
            write(`notes ${name}\n`);
        }

        return writeTokens(text, tokens, locals);
    }

    return {
        async claims(_, file) {
            return ok((await file.slice(0, firstLine.length).text()) === firstLine);
        },
        async open(fileId, name, file) {
            const parsed = parseFile(name, await file.text());
            if (parsed.error !== undefined) {
                return parsed;
            }

            files.set(fileId, parsed.value);

            return ok(undefined);
        },
        close(fileId) {
            return handleFile(fileId, () => {
                files.delete(fileId);

                return ok(undefined);
            });
        },
        provide(fileId, name) {
            return handleFile(fileId, file => {
                if (!file.neededNames.delete(name)) {
                    return failed(`${file.name} doesn't have a line 'needs ${name}'.`);
                }

                file.providedNames.push(name);

                return ok(undefined);
            });
        },
        list(fileId) {
            return handleFile(fileId, file => {
                const rows = file.rows.map(row => ({ ...row, flags: row.flags | (hasDocument(file, row) ? flagsOf('', 'document') : 0) }));

                return ok({ ...writeRows(rows), note: file.note, missingFiles: listMissingFiles(file) });
            });
        },
        read(fileId, key, view) {
            return handleFile(fileId, file => {
                const row = file.rows[key - 1];
                if (!row) {
                    return failed(`${file.name} doesn't have a symbol with the key ${key}.`);
                }
                if (!hasDocument(file, row)) {
                    return failed(`${row.name} doesn't have its own document.`);
                }
                if (!hasView(view)) {
                    return failed(`The fake engine doesn't have the view ${view}.`);
                }
                if (isHidden(row, view)) {
                    return failed(`${row.name} isn't in the view ${view}.`);
                }

                return ok(writeDocument(fileId, file, key - 1, view));
            });
        },
        describe(target, view) {
            if (!hasView(view)) {
                return failed(`The fake engine doesn't have the view ${view}.`);
            }

            const found = findTargetRow(target);
            const parsed = parseTarget(target);
            if (found) {
                const { file, row } = found;
                const container = row.parent < 0 ? null : file.paths[row.parent];
                const facts: [string, string][] = [['file', file.name], ['key', row.key.toString(16)]];

                return ok({ text: writeDeclaration(row, view).join(''), container, facts, missingFile: null });
            }

            const [name, path] = 'outside' in parsed ? parsed.outside.split('|') : [];
            const isMissing = [...files.values()].some(file => listMissingFiles(file).some(missingFile => missingFile.name === name));

            return ok<Description | null>(isMissing && path !== undefined ? { text: path, container: null, facts: [], missingFile: name } : null);
        },
        resolve(target) {
            return ok(findTargetRow(target)?.target ?? null);
        },
        findReferences(target, view) {
            if (!hasView(view)) {
                return failed(`The fake engine doesn't have the view ${view}.`);
            }

            const used = findTargetRow(target)?.target ?? target;
            const references: Reference[] = [];
            for (const [fileId, file] of files) {
                const userIndexes = new Set(file.lines.filter(line => line.row >= 0 && isUse(line, used)).map(line => line.row));
                for (const user of userIndexes) {
                    references.push({ user: formatTarget({ fileId, key: file.rows[user].key }), ranges: placeUses(file, user, used, view) });
                }
            }

            return ok(references);
        },
        listStrings(fileId) {
            return handleFile(fileId, file => {
                const strings = file.lines.filter(line => line.word === 'string');

                return ok(strings.map(line => ({ text: line.text, user: formatUser(fileId, file, line) })));
            });
        },
    };
}
