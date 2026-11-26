import { failed, ok, type Reply } from '#contract/reply';
import { type BinaryIdentity, isBinaryIdentity } from '../shared/binary-identity';
import { createRefusals } from '../shared/refusals';

/** The name of the missing file that takes the names of an IL2CPP binary's functions, like Il2CppDumper writes it. */
export const namesFileName = 'script.json';

// the largest names file that the engine reads, because `JSON.parse` keeps the file's text and each parsed function in
// the worker's memory at once, which takes a few times the file's size beside the binary's analysis
const maxNamesFileBytes = 256 * 1024 * 1024;
const refusals = createRefusals('native');
/**
 * Matches a control character, which the glue would cut or split a line at, because it reads each line as a C string,
 * and which an obfuscated game's names can have.
 */
export const controlCharacters = /[\x00-\x1f\x7f]/;

/**
 * A function of a names file in Il2CppDumper's `script.json` shape, with its address relative to the image and its C
 * signature, like `void Player__Update(struct Player_o *__this, void *method)`.
 */
export interface ScriptMethod {
    Address: number;
    Name: string;
    Signature?: string;
    /** What the function is in C#, in the text that the glue's `csharp_add_function` reads. */
    CSharp?: string;
    /** What each method that shares the function's code is in C#, in the texts that `csharp_add_sharer` reads. */
    Sharers?: string[];
}

/**
 * A names file's lines that the glue reads, the C structs that the signatures point to and the binary that the names
 * belong to, when the file has them.
 */
export interface NamesFile {
    lines: Blob;
    header?: string;
    binary?: BinaryIdentity;
}

/**
 * A metadata global of a names file, like a class's TypeInfo global with the C type of its class's struct, or a
 * string literal's global, which the file lists with its text and the engine calls `StringLiteral_` with its index.
 */
export interface ScriptGlobal {
    Address: number;
    Name?: string;
    Signature?: string;
    Value?: string;
    /** What the global is in C#, in the text that the glue's `csharp_add_global` reads. */
    CSharp?: string;
}

/** The C type of a string literal's global, the class struct of `System.String` that the IL2CPP engine's header has. */
export const stringType = 'struct String_o *';

function isScriptGlobal(value: unknown): value is ScriptGlobal {
    const global = value as Partial<ScriptGlobal> | null;

    return Number.isSafeInteger(global?.Address) && [global?.Name, global?.Signature].every(text => text === undefined || typeof text === 'string');
}

// reads an optional list of globals, or returns `undefined` for a field that isn't one
function readGlobals(value: unknown): ScriptGlobal[] | undefined {
    if (value === undefined) {
        return [];
    }

    return Array.isArray(value) && value.every(isScriptGlobal) ? value : undefined;
}

// writes a global's line, an `@` and its address relative to the image in hex, its name and its C type after a tab
function writeGlobalLine(address: number, name: string, type: string, csharp = ''): string {
    const isClean = ![name, type, csharp.replaceAll('\t', '')].some(text => controlCharacters.test(text));

    return isClean ? `@${address.toString(16)} ${name}\t${type}${csharp === '' ? '' : `\t${csharp}`}\n` : '';
}

function isScriptMethod(value: unknown): value is ScriptMethod {
    const method = value as Partial<ScriptMethod> | null;
    const hasSignature = method?.Signature === undefined || typeof method.Signature === 'string';

    return Number.isSafeInteger(method?.Address) && typeof method?.Name === 'string' && hasSignature;
}

// writes a function's line, with its signature after a tab when the signature doesn't have a control character either,
// and a line that starts with `%` for each method that shares the function's code
function writeLine({ Address, Name, Signature, CSharp, Sharers = [] }: ScriptMethod): string {
    const address = Address.toString(16);
    const hasSignature = Signature !== undefined && Signature !== '' && !controlCharacters.test(Signature);
    const hasCSharp = CSharp !== undefined && !controlCharacters.test(CSharp.replaceAll('\t', ''));
    const signature = hasSignature ? `\t${Signature}` : hasCSharp ? '\t' : '';
    const sharerLines = Sharers.filter(sharer => !controlCharacters.test(sharer.replaceAll('\t', ''))).map(sharer => `%${address}\t${sharer}\n`);

    return `${address} ${Name}${signature}${hasCSharp ? `\t${CSharp}` : ''}\n${sharerLines.join('')}`;
}

/** The functions and metadata globals of a names file, in the fields of Il2CppDumper's `script.json`. */
export interface ScriptNames {
    ScriptMethod: ScriptMethod[];
    ScriptMetadata: ScriptGlobal[];
    ScriptMetadataMethod: ScriptGlobal[];
    ScriptString: ScriptGlobal[];
}

/**
 * Writes the lines that the glue reads, each with a function's address relative to the image in hex, a space, the
 * function's name and its signature after a tab, and leaves out a name with a control character. The metadata
 * globals follow as lines that start with `@`. Returns the lines as a list, because the lines of a game with a million
 * methods pass the length of a string.
 */
export function writeNamesLines(names: ScriptNames): string[] {
    const writeMetadataLine = ({ Address, Name = '', Signature = '', CSharp }: ScriptGlobal) => {
        return Name === '' ? '' : writeGlobalLine(Address, Name, Signature || 'void *', CSharp);
    };

    return [
        ...names.ScriptMethod.filter(({ Name }) => !controlCharacters.test(Name)).map(writeLine),
        ...names.ScriptMetadata.map(writeMetadataLine),
        ...names.ScriptMetadataMethod.map(({ Address, Name = '', CSharp }) => (Name === '' ? '' : writeGlobalLine(Address, Name, 'void *', CSharp))),
        ...names.ScriptString.map(({ Address, CSharp }, index) => writeGlobalLine(Address, `StringLiteral_${index}`, stringType, CSharp)),
    ];
}

// the length of the texts that a Blob of lines joins its lines into, because a Blob of a million parts reads slowly
const maxPartLength = 1024 * 1024;

/** Joins lines into a Blob of a few parts, each a text below the length of a string. */
export function joinLines(lines: string[]): Blob {
    const parts: string[] = [];
    let part = '';
    for (const line of lines) {
        if (part.length + line.length > maxPartLength) {
            parts.push(part);
            part = '';
        }

        part += line;
    }

    return new Blob([...parts, part]);
}

/**
 * Reads a names file into the lines that `writeNamesLines` writes, from the metadata globals of `ScriptMetadata`,
 * `ScriptMetadataMethod` and `ScriptString` too. Refuses a file above 256 MB and a file in another shape. Only a file
 * that the IL2CPP engine wrote has the `Binary` and `Header` fields, because Il2CppDumper doesn't write them.
 */
export async function readNamesFile(file: Blob, name: string): Promise<Reply<NamesFile>> {
    if (file.size > maxNamesFileBytes) {
        return refusals.largeFile(name, maxNamesFileBytes);
    }

    let parsed: { Binary?: unknown; Header?: unknown; ScriptMethod?: unknown; [globals: string]: unknown } | null;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        parsed = null;
    }

    const methods = parsed?.ScriptMethod;
    const hasBinary = parsed?.Binary === undefined || isBinaryIdentity(parsed.Binary);
    const hasHeader = parsed?.Header === undefined || typeof parsed.Header === 'string';
    if (!Array.isArray(methods) || !methods.every(isScriptMethod) || !hasBinary || !hasHeader) {
        return failed(`${name} isn't a names file in Il2CppDumper's script.json shape.`);
    }

    const globalFields = ['ScriptMetadata', 'ScriptMetadataMethod', 'ScriptString'];
    const [metadata, metadataMethods, strings] = globalFields.map(field => readGlobals(parsed?.[field]));
    if (!metadata || !metadataMethods || !strings) {
        return failed(`${name} isn't a names file in Il2CppDumper's script.json shape.`);
    }

    const lines = writeNamesLines({ ScriptMethod: methods, ScriptMetadata: metadata, ScriptMetadataMethod: metadataMethods, ScriptString: strings });

    return ok({ lines: joinLines(lines), header: parsed?.Header as string | undefined, binary: parsed?.Binary as BinaryIdentity | undefined });
}
