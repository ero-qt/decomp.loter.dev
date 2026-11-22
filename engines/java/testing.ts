import { crc32, deflateRawSync } from 'node:zlib';
import type { Engine } from '../../contract/engine';
import { useEngine } from '../shared/testing';
import { createJavaHandlers } from './handlers';

/** An entry of a zip file that `zipFile` writes. */
export interface ZipEntry {
    name: string;
    bytes: Uint8Array;
    /** Whether the entry's bytes are stored as they are, not deflated. */
    stored?: boolean;
    /** Values that replace the entry's real flags, method and size, for damaged and hostile files. */
    flags?: number;
    method?: number;
    size?: number;
}

/**
 * Writes a zip file with the entries in their order and with zero timestamps, so the same entries give the same bytes.
 */
export function zipFile(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
    const locals: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;

    for (const { name, bytes, stored = false, flags = 0, method = stored ? 0 : 8, size = bytes.length } of entries) {
        const nameBytes = Buffer.from(name);
        const data = stored ? Buffer.from(bytes) : deflateRawSync(bytes);

        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(flags, 6);
        header.writeUInt16LE(method, 8);
        header.writeUInt32LE(crc32(bytes), 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(size, 22);
        header.writeUInt16LE(nameBytes.length, 26);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        header.copy(entry, 8, 6, 26);
        entry.writeUInt16LE(nameBytes.length, 28);
        entry.writeUInt32LE(offset, 42);

        locals.push(header, nameBytes, data);
        directory.push(entry, nameBytes);
        offset += header.length + nameBytes.length + data.length;
    }

    const directoryBytes = Buffer.concat(directory);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directoryBytes.length, 12);
    end.writeUInt32LE(offset, 16);

    return new Uint8Array(Buffer.concat([...locals, directoryBytes, end]));
}

/**
 * Serves the Java engine in an in-thread worker during each test of a file and returns the function that connects a
 * test. The cancel limit lets a canceled decompile finish because Vineflower can't stop in the middle.
 */
export function useJavaEngine(): () => Engine {
    return useEngine(createJavaHandlers, { timeLimitMs: 60000, cancelLimitMs: 30000, hasLinkedFiles: true });
}

/** A nested, local or anonymous class in the `InnerClasses` attribute that `classFile` writes. */
export interface InnerClassEntry {
    inner: string;
    outer?: string;
    simpleName?: string;
    access?: number;
}

/** A class without methods that `classFile` writes, for the classes of hostile files that javac doesn't write. */
export interface ClassFileShape {
    name: string;
    /** Fields with an optional constant text, which the class file has in the field's `ConstantValue` attribute. */
    fields?: { name: string; descriptor: string; value?: string }[];
    innerClasses?: InnerClassEntry[];
    /** The class whose method contains a local or anonymous class. */
    enclosingClass?: string;
}

// writes a UTF-16 code unit in modified UTF-8, which writes each surrogate of a pair as 3 bytes
function encodeUnit(unit: number): number[] {
    if (unit > 0 && unit < 0x80) {
        return [unit];
    }
    if (unit < 0x800) {
        return [0xc0 | (unit >> 6), 0x80 | (unit & 0x3f)];
    }

    return [0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f)];
}

/**
 * Writes a class file with public fields and its texts in modified UTF-8, which writes the character 0 as 2 bytes and a
 * character outside the BMP as 2 surrogates.
 */
export function classFile({ name, fields = [], innerClasses = [], enclosingClass }: ClassFileShape): Uint8Array<ArrayBuffer> {
    const pool: number[][] = [];
    // tagged text of a constant -> its index in the pool
    const indexes = new Map<string, number>();
    const u2 = (value: number) => [value >> 8, value & 0xff];
    const u4 = (value: number) => [...u2(value >>> 16), ...u2(value & 0xffff)];

    function add(key: string, bytes: number[]): number {
        if (!indexes.has(key)) {
            indexes.set(key, pool.push(bytes));
        }

        return indexes.get(key)!;
    }

    function utf8(text: string): number {
        const bytes = Array.from({ length: text.length }, (_, index) => encodeUnit(text.charCodeAt(index))).flat();

        return add(`text ${text}`, [1, ...u2(bytes.length), ...bytes]);
    }

    const classRef = (className: string) => add(`class ${className}`, [7, ...u2(utf8(className))]);

    const header = [...u2(0x21), ...u2(classRef(name)), ...u2(classRef('java/lang/Object')), ...u2(0)];
    const fieldBytes = fields.flatMap(({ name: fieldName, descriptor, value }) => {
        const head = [...u2(utf8(fieldName)), ...u2(utf8(descriptor))];
        if (value === undefined) {
            return [...u2(1), ...head, ...u2(0)];
        }

        const constant = add(`string ${value}`, [8, ...u2(utf8(value))]);
        // writes `public static final` because javac only writes a constant value for such a field
        return [...u2(0x19), ...head, ...u2(1), ...u2(utf8('ConstantValue')), ...u4(2), ...u2(constant)];
    });

    const inner = innerClasses.flatMap(({ inner: innerName, outer, simpleName, access = 1 }) => {
        return [...u2(classRef(innerName)), ...u2(outer ? classRef(outer) : 0), ...u2(simpleName ? utf8(simpleName) : 0), ...u2(access)];
    });

    const attributes = [
        ...(innerClasses.length > 0 ? [[...u2(utf8('InnerClasses')), ...u4(2 + inner.length), ...u2(innerClasses.length), ...inner]] : []),
        ...(enclosingClass ? [[...u2(utf8('EnclosingMethod')), ...u4(4), ...u2(classRef(enclosingClass)), ...u2(0)]] : []),
    ];

    return Uint8Array.from([
        ...[0xca, 0xfe, 0xba, 0xbe, ...u2(0), ...u2(65), ...u2(pool.length + 1)],
        ...pool.flat(),
        ...header,
        ...[...u2(fields.length), ...fieldBytes, ...u2(0), ...u2(attributes.length)],
        ...attributes.flat(),
    ]);
}
