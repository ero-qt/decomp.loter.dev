import { type Document, formatTarget, parseTarget, readTokens, type Token, writeTokens } from '#contract/document';
import type { EmbeddedLines } from '#contract/embedding';
import type { Row } from '#contract/rows';
import { isStaticField, listInstanceFields, nameStructs } from './c-types';
import { listClassStructs } from './class-structs';
import { type Game, type GameGlobal, globalKinds } from './game';
import { firstKeys, indexCodeMethods, type MemberStarts, writeBinaryKey } from './rows';
import { indexSharers, type Sharer } from './shared-code';

/** A game with the lookups that the links of its bodies need. */
export interface BodyGame {
    game: Game;
    starts: MemberStarts;
    rowsByKey: Map<number, Row>;
}

/** The functions that give the tokens of the native engine's code their targets in the game. */
export interface BodyLinker {
    /** Links the tokens of a method's C#. */
    link(lines: EmbeddedLines): EmbeddedLines;
    /** Links the tokens of the C of a function of the binary that isn't a method, or of the note of a global's data. */
    linkDocument(document: Document): Document;
}

/**
 * Returns the functions that give the tokens of the native engine's code their targets in the game. A function becomes
 * the method whose code it is, because the native engine's key of a function is the code's address relative to the
 * image. A metadata global gets the tokens of the types and members that its C# text names. A link of the C# printer
 * becomes the type or field of its struct, the property of its accessor, the method that a call of shared code reads
 * as or the class of the exception that a throw raises. Any other function or global of the binary gets the key of
 * `writeBinaryKey`, which the engine reads as the binary's own C. `findCode` gives the address of a method's code.
 */
export function createBodyLinker(fileId: number, { game, starts, rowsByKey }: BodyGame, findCode: (rva: number) => number): BodyLinker {
    const codeMethods = indexCodeMethods(game, starts, findCode);
    let globals: Map<number, GameGlobal> | undefined;
    let structs: Map<string, { typeIndex: number; isStatic: boolean }> | undefined;
    let systemClasses: Map<string, number> | undefined;
    let properties: Map<number, number> | undefined;
    let sharers: Map<number, Sharer[]> | undefined;
    // the keys of each struct's fields by their offsets, by the type's index and whether the struct is static
    const fields = new Map<string, Map<number, number>>();

    // indexes the structs of the classes' objects and of their static fields by their names, like `Circle_o`
    function indexStructs(): Map<string, { typeIndex: number; isStatic: boolean }> {
        const types = nameStructs(game, game.pointerSize);
        const indexed = new Map([...types.structNames].map(([typeIndex, name]) => [name, { typeIndex, isStatic: false }]));
        for (const [typeIndex, name] of listClassStructs(types).staticStructs) {
            indexed.set(name, { typeIndex, isStatic: true });
        }

        return indexed;
    }

    function useFields(typeIndex: number, isStatic: boolean): Map<number, number> {
        const id = `${typeIndex}:${isStatic}`;
        if (!fields.has(id)) {
            const keys = new Map<number, number>();
            const listed = isStatic ? game.types[typeIndex].fields.filter(isStaticField) : listInstanceFields(game, typeIndex);
            const findBase = (index: number) => (isStatic ? -1 : (game.types[index].baseType?.definition ?? -1));
            // finds a base class's field in the base class, which has the field's row
            for (let index = typeIndex; index >= 0 && keys.size < listed.length; index = findBase(index)) {
                game.types[index].fields.forEach((field, fieldIndex) => {
                    if (listed.includes(field) && !keys.has(field.offset!)) {
                        keys.set(field.offset!, firstKeys.field + starts.fields[index] + fieldIndex);
                    }
                });
            }

            fields.set(id, keys);
        }

        return fields.get(id)!;
    }

    function linkRow(token: Token, key: number | undefined): Token {
        const row = key === undefined ? undefined : rowsByKey.get(key);

        return row ? { ...token, kind: row.kind, target: formatTarget({ fileId, key: row.key }) } : { ...token, target: null };
    }

    // finds the class of `System` with a name, like the class of an exception that the runtime raises
    function findSystemClass(name: string): number | undefined {
        if (!systemClasses) {
            systemClasses = new Map();
            game.types.forEach((type, index) => {
                if (type.namespace === 'System' && type.declaringType < 0) {
                    systemClasses!.set(type.name, index);
                }
            });
        }

        return systemClasses.get(name);
    }

    // indexes the keys of the properties' rows by the keys of their accessors' rows
    function indexProperties(): Map<number, number> {
        const indexed = new Map<number, number>();
        game.types.forEach((type, typeIndex) => {
            type.properties.forEach(({ getter, setter }, index) => {
                const key = firstKeys.property + starts.properties[typeIndex] + index;
                // leaves out the -1 of a property without the accessor
                for (const accessor of [getter, setter].filter(accessor => accessor >= 0)) {
                    indexed.set(firstKeys.method + starts.methods[typeIndex] + accessor, key);
                }
            });
        });

        return indexed;
    }

    // resolves a link of the C# printer, `#type:<struct>`, `#field:<struct>:<offset>`, `#declaring_type:<key>`,
    // `#property:<key>`, `#sharer:<key>:<index>`, `#sharer_type:<key>:<index>` or `#raised_type:<class>`. A sharer's
    // accessor links to its property, whose name the call reads as.
    function linkOutside(token: Token, outside: string): Token {
        const [kind, name, offset] = outside.split(':');
        if (kind === '#raised_type') {
            return linkRow(token, findSystemClass(name));
        }
        if (kind === '#property') {
            properties ??= indexProperties();
            const accessor = codeMethods.get(parseInt(name, 16));

            return linkRow(token, accessor ? properties.get(accessor.key) : undefined);
        }
        if (kind === '#sharer' || kind === '#sharer_type') {
            sharers ??= indexSharers(game, starts, findCode);
            properties ??= indexProperties();
            const sharer = sharers.get(parseInt(name, 16))?.[Number(offset)];
            const key = sharer && (kind === '#sharer_type' ? sharer.typeIndex : (properties.get(sharer.key) ?? sharer.key));

            return linkRow(token, key);
        }

        structs ??= indexStructs();
        const struct = structs.get(name);
        if (kind === '#type') {
            return linkRow(token, struct?.typeIndex);
        }
        if (kind === '#field') {
            return linkRow(token, struct && useFields(struct.typeIndex, struct.isStatic).get(parseInt(offset, 16)));
        }

        return linkRow(token, codeMethods.get(parseInt(name, 16))?.typeIndex);
    }

    // returns the key of the row that a part of a global's text names, a type or the global's method or field
    function findPartKey(global: GameGlobal, { definition, isMember }: GameGlobal['parts'][number]): number | undefined {
        if (!isMember) {
            return definition;
        }
        if (global.definition < 0 || global.member < 0) {
            return undefined;
        }

        const isField = global.kind === globalKinds.fieldInfo;
        const firstKey = isField ? firstKeys.field + starts.fields[global.definition] : firstKeys.method + starts.methods[global.definition];

        return firstKey + global.member;
    }

    // writes the tokens of the types and members that a metadata global's token names. The printer writes the global's
    // whole C# text, only the type in it, like the class of `new Circle()`, or only the member, like a called method.
    // The global's name in C links to its member or its type, or to the global's data.
    function linkGlobal(text: string, token: Token, global: GameGlobal): Token[] {
        const written = text.slice(token.start, token.start + token.length);
        const typeEnd = global.typeStart + global.typeLength;
        const member = global.parts.find(part => part.isMember);
        let [from, to] = [0, global.text.length];
        if (written !== global.text && written === global.text.slice(global.typeStart, typeEnd)) {
            [from, to] = [global.typeStart, typeEnd];
        } else if (written !== global.text && member && written === global.text.slice(member.start, member.start + member.length)) {
            [from, to] = [member.start, member.start + member.length];
        } else if (written !== global.text) {
            const named = member ?? global.parts[0];
            const data = formatTarget({ fileId, key: writeBinaryKey(global.rva) });

            return [named ? linkRow(token, findPartKey(global, named)) : { ...token, target: data }];
        }

        return global.parts
            .filter(part => part.start >= from && part.start + part.length <= to)
            .map(part => linkRow({ ...token, start: token.start + part.start - from, length: part.length }, findPartKey(global, part)));
    }

    function linkTokens(text: string, tokens: Token[]): Token[] {
        return tokens.flatMap((token): Token[] => {
            const parsed = token.target === null ? undefined : parseTarget(token.target);
            if (!parsed || 'local' in parsed) {
                return [token];
            }
            if ('outside' in parsed) {
                return [parsed.outside.startsWith('#') ? linkOutside(token, parsed.outside) : token];
            }

            const code = parsed.key >>> 0;
            const method = codeMethods.get(code);
            if (method) {
                return [linkRow(token, method.key)];
            }

            globals ??= new Map(game.globals.map(global => [global.rva, global]));
            const global = globals.get(code);

            return global ? linkGlobal(text, token, global) : [{ ...token, target: formatTarget({ fileId, key: writeBinaryKey(parsed.key) }) }];
        });
    }

    return {
        link: lines => ({ ...lines, tokens: linkTokens(lines.text, lines.tokens) }),
        linkDocument: document => writeTokens(document.text, linkTokens(document.text, readTokens(document)), document.locals),
    };
}
