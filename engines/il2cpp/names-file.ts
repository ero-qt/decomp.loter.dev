import {
    controlCharacters,
    joinLines,
    type ScriptGlobal,
    type ScriptMethod,
    type ScriptNames,
    stringType,
    writeNamesLines,
} from '../native/names-file';
import {
    type CTypes,
    isStaticField,
    listInstanceFields,
    listStructs,
    nameStructs,
    writeArrayStruct,
    writeSharedSignature,
    writeSignature,
} from './c-types';
import { type ClassStructs, listClassStructs, plainClassStruct } from './class-structs';
import { createRecordWriter, formatRecord, nameType, writeArrayLines, writeSharedRecord, writeStructLines } from './csharp-names';
import { type Game, type GameField, type GameGlobal, globalKinds } from './game';
import { formatFullName, listOuterTypes } from './rows';
import { writeHelperLines } from './runtime-helpers';
import { nameSharedCode } from './shared-code';

// matches each control character, which the native engine would leave a whole name out for
const eachControlCharacter = new RegExp(controlCharacters, 'g');

// writes a type's C# name after the namespace of its outermost type, like `UnityEngine.Debug` or
// `System.Collections.Generic.List<int>`, or only the name of a type without a definition
function formatGlobalType(game: Game, { name, definition }: GameGlobal): string {
    if (definition < 0) {
        return name;
    }
    if (!/[<[*]/.test(name)) {
        return formatFullName(game, definition);
    }

    const { namespace } = listOuterTypes(game, definition)[0] ?? game.types[definition];

    return namespace === '' ? name : `${namespace}.${name}`;
}

/**
 * Names a metadata global in Il2CppDumper's shape, a TypeInfo global as `UnityEngine.Debug_TypeInfo`, a method's
 * global as `Method$UnityEngine.Debug.Log()` and a string literal's global by its number among the string literals'
 * globals, like `StringLiteral_0`, without control characters.
 */
function nameGlobal(game: Game, global: GameGlobal, stringNumber: number): string {
    const owner = () => (global.definition >= 0 ? formatFullName(game, global.definition) : '');
    const name = () => {
        switch (global.kind) {
            case globalKinds.typeInfo:
                return `${formatGlobalType(game, global)}_TypeInfo`;
            case globalKinds.type:
                return `${formatGlobalType(game, global)}_var`;
            case globalKinds.fieldInfo:
                return `Field$${owner()}.${global.name}`;
            case globalKinds.methodDef:
                return `Method$${owner()}.${global.name}()`;
            case globalKinds.methodRef:
                return `Method$${global.name}()`;
            case globalKinds.stringLiteral:
                return `StringLiteral_${stringNumber}`;
            default:
                return '';
        }
    };

    return name().replace(eachControlCharacter, '');
}

// writes what a global is in C# for the native engine's C# printer: its text, the name of the type in the text and,
// for a method's global, the method's record and name
function writeGlobalRecord(game: Game, global: GameGlobal): string {
    const isMethod = global.kind === globalKinds.methodDef || global.kind === globalKinds.methodRef;
    const type = isMethod ? game.types[global.definition] : undefined;
    const method = type?.methods[global.member];
    const record = type && method ? createRecordWriter(type)(method, global.member) : { head: '', name: '' };
    const typeText = global.text.slice(global.typeStart, global.typeStart + global.typeLength);

    return `${global.text}\t${typeText}\t${record.head}\t${record.name}`;
}

/**
 * Writes the binary's metadata globals in Il2CppDumper's shape, a TypeInfo global with its class's `_c` struct, a
 * method's global and each string literal's global with its text.
 */
function writeGlobals(game: Game, structs: ClassStructs): Omit<ScriptNames, 'ScriptMethod'> {
    const metadata: ScriptGlobal[] = [];
    const methods: ScriptGlobal[] = [];
    const strings: ScriptGlobal[] = [];

    for (const global of game.globals) {
        const name = () => nameGlobal(game, global, -1);
        const CSharp = writeGlobalRecord(game, global);
        switch (global.kind) {
            case globalKinds.typeInfo: {
                const signature = structs.pointerTypes.get(global.definition) ?? `struct ${plainClassStruct} *`;
                metadata.push({ Address: global.rva, Name: name(), Signature: signature, CSharp });
                break;
            }
            case globalKinds.type:
            case globalKinds.fieldInfo:
                metadata.push({ Address: global.rva, Name: name(), Signature: 'void *', CSharp });
                break;
            case globalKinds.methodDef:
            case globalKinds.methodRef:
                methods.push({ Address: global.rva, Name: name(), CSharp });
                break;
            case globalKinds.stringLiteral:
                strings.push({ Address: global.rva, Value: game.strings[global.definition] ?? '', CSharp });
                break;
        }
    }

    return { ScriptMetadata: metadata, ScriptMetadataMethod: methods, ScriptString: strings };
}

/** Names a method's function like Il2CppDumper, like `Shapes.Circle$$Area`, without control characters. */
export function nameMethod(typeName: string, methodName: string): string {
    return `${typeName}$$${methodName}`.replace(eachControlCharacter, '');
}

// the levels of structs below the structs of a signature or a global that the C of a method gets, like the struct of
// `__this->player->inventory`, because the decompiler only reads a struct's fields through a struct that it has
const structLevels = 2;
// matches each struct that a C type points to, like `Player_o` in `struct Player_o *`
const eachStructPointer = /struct (\w+) \*/g;

function listPointedStructs(cType: string): string[] {
    return [...cType.matchAll(eachStructPointer)].map(match => match[1]);
}

/** The writers of a struct of the header and of the struct's lines for the C# printer. */
interface StructWriter {
    write(): string;
    writeLines(): string;
}

/** Finds the writers of a struct by the struct's name. */
type FindStructWriter = (name: string) => StructWriter | undefined;

// returns the function that finds the writers of the structs of the classes' objects, of their static fields, of their
// `Il2CppClass` and of the arrays that the structs and signatures written so far have
function listStructWriters(types: CTypes, classStructs: ClassStructs): FindStructWriter {
    const { game } = types;
    const writers = new Map<string, StructWriter>();
    for (const [name, write] of classStructs.structs) {
        writers.set(name, { write, writeLines: () => '' });
    }
    for (const [name, write] of listStructs(types)) {
        writers.set(name, { write, writeLines: () => '' });
    }
    for (const [typeIndex, name] of types.structNames) {
        const writeLines = () => writeStructLines(name, game.types[typeIndex], 'o', listInstanceFields(game, typeIndex));
        writers.set(name, { write: writers.get(name)!.write, writeLines });
    }
    for (const [typeIndex, name] of classStructs.staticStructs) {
        const byOffset = (first: GameField, second: GameField) => first.offset! - second.offset!;
        const listFields = () => game.types[typeIndex].fields.filter(isStaticField).sort(byOffset);
        const writeLines = () => writeStructLines(name, game.types[typeIndex], 's', listFields());
        writers.set(name, { write: writers.get(name)!.write, writeLines });
    }

    return name => {
        const array = types.arrayStructs.get(name);

        return array ? { write: () => writeArrayStruct(types, name, array), writeLines: () => writeArrayLines(name, array) } : writers.get(name);
    };
}

// writes the name, C signature and C# record of each method with code, the metadata globals and the writers of the
// structs of the classes that the signatures and the TypeInfo globals point to by the structs' names
function writeNames(game: Game): { names: ScriptNames; structs: FindStructWriter } {
    const types = nameStructs(game, game.pointerSize);
    const classStructs = listClassStructs(types);
    const withCode = game.types.flatMap((type, typeIndex) => {
        const writeRecord = createRecordWriter(type);

        return type.methods.flatMap((method, index) => (method.rva === null ? [] : [{ typeIndex, method, record: writeRecord(method, index) }]));
    });
    // gives the code that several methods share 1 name and the signature that they agree on, not those of 1 of them
    const methods = [...Map.groupBy(withCode, ({ method }) => method.rva!)].map(([rva, sharers]): ScriptMethod => {
        const [{ typeIndex, method, record }] = sharers;
        if (sharers.length > 1) {
            const Name = nameSharedCode(rva);
            const CSharp = writeSharedRecord(sharers.map(sharer => sharer.method), sharers.map(sharer => sharer.record), Name);

            return { Address: rva, Name, Signature: writeSharedSignature(types, sharers, Name), CSharp };
        }

        const Name = nameMethod(formatFullName(game, typeIndex), method.name);

        const CSharp = formatRecord(record, nameType(game.types[typeIndex]));

        return { Address: rva, Name, Signature: writeSignature(types, typeIndex, method), CSharp };
    });
    return { names: { ScriptMethod: methods, ...writeGlobals(game, classStructs) }, structs: listStructWriters(types, classStructs) };
}

/**
 * The names of a game's methods in the lines that the native engine's glue reads, with the writer of the structs and
 * globals that a method's code needs.
 */
export interface NativeNames {
    /** The lines of the methods, without the globals. */
    lines: Blob;
    /**
     * Writes the C structs that the signatures and the globals at the addresses point to, with 2 levels of the structs
     * that their members point to, and the lines of the globals at the addresses and of the structs' C# names. Leaves
     * out the structs and globals that an earlier call wrote, because those of a whole game take the native engine
     * seconds and a gigabyte.
     */
    writeTypes(rvas: number[]): { header: string; globals: string };
}

// writes the line of each global by its address relative to the image, with the string literals' numbers of the
// lines of a whole names file
function indexGlobalLines({ ScriptMetadata, ScriptMetadataMethod, ScriptString }: ScriptNames): Map<number, string> {
    const lines = writeNamesLines({ ScriptMethod: [], ScriptMetadata, ScriptMetadataMethod, ScriptString });
    const globalLines = new Map<number, string>();
    [...ScriptMetadata, ...ScriptMetadataMethod, ...ScriptString].forEach(({ Address }, index) => {
        globalLines.set(Address, (globalLines.get(Address) ?? '') + lines[index]);
    });

    return globalLines;
}

// returns the function that writes the structs that the C types at addresses point to, with `structLevels` levels of
// the structs that their members point to, and leaves out the structs that an earlier call wrote
function createStructWriter(cTypes: Map<number, string>, findWriter: FindStructWriter): (rvas: number[]) => { header: string; lines: string } {
    // the most levels below each struct that the writes reached
    const reached = new Map<string, number>();

    return rvas => {
        const texts: string[] = [];
        const lines: string[] = [];
        const queue = rvas.flatMap(rva => listPointedStructs(cTypes.get(rva) ?? '')).map(name => ({ name, levels: structLevels }));
        for (let next = queue.shift(); next; next = queue.shift()) {
            const { name, levels } = next;
            const writer = findWriter(name);
            if (!writer || (reached.get(name) ?? -1) >= levels) {
                continue;
            }

            const text = writer.write();
            if (!reached.has(name)) {
                texts.push(text);
                lines.push(writer.writeLines());
            }

            reached.set(name, levels);
            if (levels > 0) {
                queue.push(...listPointedStructs(text).map(pointed => ({ name: pointed, levels: levels - 1 })));
            }
        }

        return { header: texts.join(''), lines: lines.join('') };
    };
}

/**
 * Writes the name, C signature and C# record of each method with code at its address relative to the image, like
 * `Shapes.Circle$$Area`, in the lines that the native engine's glue reads, without control characters and without the
 * structs and globals, which `writeTypes` writes for each method's code. `findCode` gives the address of a method's
 * code, which the native engine's function starts at.
 */
export function writeNativeNames(game: Game, findCode: (rva: number) => number = rva => rva): NativeNames {
    const { names, structs } = writeNames(game);
    const cTypes = new Map<number, string>();
    for (const { Address, Signature = '' } of names.ScriptMethod) {
        cTypes.set(findCode(Address), Signature);
    }
    for (const { Address, Signature = '' } of names.ScriptMetadata) {
        cTypes.set(Address, Signature);
    }
    for (const { Address } of names.ScriptString) {
        cTypes.set(Address, stringType);
    }

    const writeStructs = createStructWriter(cTypes, structs);
    const globalLines = indexGlobalLines(names);
    const methodLines = writeNamesLines({ ScriptMethod: names.ScriptMethod, ScriptMetadata: [], ScriptMetadataMethod: [], ScriptString: [] });

    return {
        lines: joinLines([...methodLines, ...writeHelperLines()]),
        writeTypes(rvas) {
            const globals = rvas.map(rva => globalLines.get(rva) ?? '').join('');
            for (const rva of rvas) {
                globalLines.delete(rva);
            }

            const { header, lines } = writeStructs(rvas);

            return { header, globals: globals + lines };
        },
    };
}
