import { formatTarget, type Token } from '#contract/document';
import type { EmbeddedLines } from '#contract/embedding';
import type { Game } from './game';
import { firstKeys, type MemberStarts, stripArity } from './rows';

/**
 * A method whose code other methods share, with its row's key, its name after its type's, like `Circle.Area` or
 * `Circle.Circle` for a constructor, and its type's index.
 */
export interface Sharer {
    key: number;
    name: string;
    typeIndex: number;
}

// the methods that a note of shared code lists by name, because thousands of empty methods can share 1 function
const maxListed = 3;

/** Returns the name of the function with code that several methods share, from the code's address relative to the image. */
export function nameSharedCode(rva: number): string {
    return `shared_${rva.toString(16)}`;
}

// names a method after its type's name, and a constructor after its class like C# does, `Circle.Circle`
function nameSharer(typeName: string, name: string): string {
    const type = stripArity(typeName);

    return `${type}.${name === '.ctor' || name === '.cctor' ? type : name}`;
}

/**
 * Indexes the methods that share their code with other methods by the address of the code that `findCode` gives, like
 * the getters that MSVC's identical code folding merges into 1 function.
 */
export function indexSharers(game: Game, starts: MemberStarts, findCode: (rva: number) => number): Map<number, Sharer[]> {
    const byCode = new Map<number, Sharer[]>();
    game.types.forEach((type, typeIndex) => {
        type.methods.forEach(({ name, rva }, index) => {
            if (rva !== null) {
                const code = findCode(rva);
                const sharer = { key: firstKeys.method + starts.methods[typeIndex] + index, name: nameSharer(type.name, name), typeIndex };
                byCode.set(code, [...(byCode.get(code) ?? []), sharer]);
            }
        });
    });

    return new Map([...byCode].filter(([, sharers]) => sharers.length > 1));
}

/**
 * Puts a comment before the C of shared code with the other methods that share the code, each with a link to its row,
 * indented like the C's own lines. The comment only has the count of the methods after the first 3.
 */
export function noteSharers(lines: EmbeddedLines, others: Sharer[], fileId: number): EmbeddedLines {
    const tokens: Token[] = [];
    let note = '    // Shares its code with ';
    others.slice(0, maxListed).forEach(({ key, name }, index) => {
        note += index === 0 ? '' : ', ';
        tokens.push({ start: note.length, length: name.length, kind: 'method', flags: 0, target: formatTarget({ fileId, key }) });
        note += name;
    });

    const rest = others.length - maxListed;
    note += rest > 0 ? ` and ${rest} more ${rest === 1 ? 'method' : 'methods'}.\n` : '.\n';

    return {
        text: note + lines.text,
        tokens: [...tokens, ...lines.tokens.map(token => ({ ...token, start: token.start + note.length }))],
        locals: lines.locals,
    };
}
