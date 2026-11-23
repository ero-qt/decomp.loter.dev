import { AttributeType, ConstantType, Opcode } from '@katana-project/asm/spec';

// the bytes after the tag of each constant pool entry that doesn't have a length of its own (JVMS 4.4)
const entryBytes = new Map<number, number>([
    [ConstantType.INTEGER, 4],
    [ConstantType.FLOAT, 4],
    [ConstantType.LONG, 8],
    [ConstantType.DOUBLE, 8],
    [ConstantType.CLASS, 2],
    [ConstantType.STRING, 2],
    [ConstantType.FIELDREF, 4],
    [ConstantType.METHODREF, 4],
    [ConstantType.INTERFACE_METHODREF, 4],
    [ConstantType.NAME_AND_TYPE, 4],
    [ConstantType.METHOD_HANDLE, 3],
    [ConstantType.METHOD_TYPE, 2],
    [ConstantType.DYNAMIC, 4],
    [ConstantType.INVOKE_DYNAMIC, 4],
    [ConstantType.MODULE, 2],
    [ConstantType.PACKAGE, 2],
]);

// the operand bytes of each run of opcodes from the first to the last, for every instruction except the switches and
// `wide` (JVMS 6.5)
const operandRuns: [first: Opcode, last: Opcode, bytes: number][] = [
    [Opcode.NOP, Opcode.DCONST_1, 0],
    [Opcode.BIPUSH, Opcode.BIPUSH, 1],
    [Opcode.SIPUSH, Opcode.SIPUSH, 2],
    [Opcode.LDC, Opcode.LDC, 1],
    [Opcode.LDC_W, Opcode.LDC2_W, 2],
    [Opcode.ILOAD, Opcode.ALOAD, 1],
    [Opcode.ILOAD_0, Opcode.SALOAD, 0],
    [Opcode.ISTORE, Opcode.ASTORE, 1],
    [Opcode.ISTORE_0, Opcode.LXOR, 0],
    [Opcode.IINC, Opcode.IINC, 2],
    [Opcode.I2L, Opcode.DCMPG, 0],
    [Opcode.IFEQ, Opcode.JSR, 2],
    [Opcode.RET, Opcode.RET, 1],
    [Opcode.IRETURN, Opcode.RETURN, 0],
    [Opcode.GETSTATIC, Opcode.INVOKESTATIC, 2],
    [Opcode.INVOKEINTERFACE, Opcode.INVOKEDYNAMIC, 4],
    [Opcode.NEW, Opcode.NEW, 2],
    [Opcode.NEWARRAY, Opcode.NEWARRAY, 1],
    [Opcode.ANEWARRAY, Opcode.ANEWARRAY, 2],
    [Opcode.ARRAYLENGTH, Opcode.ATHROW, 0],
    [Opcode.CHECKCAST, Opcode.INSTANCEOF, 2],
    [Opcode.MONITORENTER, Opcode.MONITOREXIT, 0],
    [Opcode.MULTIANEWARRAY, Opcode.MULTIANEWARRAY, 3],
    [Opcode.IFNULL, Opcode.IFNONNULL, 2],
    [Opcode.GOTO_W, Opcode.JSR_W, 4],
];
const operandBytes = new Map(operandRuns.flatMap(([first, last, bytes]) => {
    return Array.from({ length: last - first + 1 }, (_, index): [number, number] => [first + index, bytes]);
}));

const decoder = new TextDecoder();

// reads a signed 32-bit number like asm's instruction reader does, which reads the bytes past the code's end as 0
function readInt32(code: Uint8Array, offset: number): number {
    return (code[offset] << 24) | (code[offset + 1] << 16) | (code[offset + 2] << 8) | code[offset + 3];
}

// returns the switch in a method's code that makes asm's instruction reader step back and read the same instructions
// again without end, else `undefined`
function findSwitchInCode(code: Uint8Array): string | undefined {
    let offset = 0;
    while (offset < code.length) {
        const opcode = code[offset];
        // the operands of a switch start after padding up to the next multiple of 4
        const operands = (offset + 4) & ~3;

        if (opcode === Opcode.LOOKUPSWITCH) {
            const pairs = readInt32(code, operands + 4);
            if (pairs < 0) {
                return 'a lookupswitch with a negative count of pairs';
            }

            offset = operands + 8 + pairs * 8;
        } else if (opcode === Opcode.TABLESWITCH) {
            const low = readInt32(code, operands + 4);
            const high = readInt32(code, operands + 8);
            if (high < low) {
                return 'a tableswitch whose high is below its low';
            }

            offset = operands + 12 + (high - low + 1) * 4;
        } else if (opcode === Opcode.WIDE) {
            offset += code[offset + 1] === Opcode.IINC ? 6 : 4;
        } else {
            // stops at an unknown opcode because asm's instruction reader refuses it
            const bytes = operandBytes.get(opcode);
            if (bytes === undefined) {
                return undefined;
            }

            offset += 1 + bytes;
        }
    }

    return undefined;
}

// skips the constant pool and returns the offset after it with the index of the text `Code`, which is 0 without the
// text, or `undefined` for an unknown tag, which asm's reader refuses
function skipPool(view: DataView): { offset: number; codeIndex: number } | undefined {
    const count = view.getUint16(8);
    let offset = 10;
    let codeIndex = 0;

    for (let index = 1; index < count; index++) {
        const tag = view.getUint8(offset);
        if (tag === ConstantType.UTF8) {
            const length = view.getUint16(offset + 1);
            const text = length === AttributeType.CODE.length ? new Uint8Array(view.buffer, view.byteOffset + offset + 3, length) : undefined;
            if (text && decoder.decode(text) === AttributeType.CODE) {
                codeIndex = index;
            }

            offset += 3 + length;
            continue;
        }

        const bytes = entryBytes.get(tag);
        if (bytes === undefined) {
            return undefined;
        }

        offset += 1 + bytes;
        // a long or a double takes 2 indexes of the pool
        if (tag === ConstantType.LONG || tag === ConstantType.DOUBLE) {
            index++;
        }
    }

    return { offset, codeIndex };
}

// walks the fields or methods at the offset with the name index and the data's offset of each attribute, and returns
// the offset after them
function walkMembers(view: DataView, start: number, visit: (nameIndex: number, dataOffset: number) => void): number {
    const count = view.getUint16(start);
    let offset = start + 2;

    for (let member = 0; member < count; member++) {
        const attributes = view.getUint16(offset + 6);
        offset += 8;

        for (let attribute = 0; attribute < attributes; attribute++) {
            const length = view.getUint32(offset + 2);
            visit(view.getUint16(offset), offset + 6);
            offset += 6 + length;
        }
    }

    return offset;
}

/**
 * Finds a switch in a class file's methods with a negative count, which makes asm's reader loop until memory runs out,
 * and returns what it found, else `undefined`. Returns `undefined` for a class file that ends early too, because asm's
 * reader then refuses the class file itself.
 */
export function findEndlessSwitch(bytes: Uint8Array): string | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    try {
        const pool = skipPool(view);
        if (pool === undefined || pool.codeIndex === 0) {
            return undefined;
        }

        // skips the access flags, the class, the superclass and the interfaces
        const afterInterfaces = pool.offset + 8 + view.getUint16(pool.offset + 6) * 2;
        const afterFields = walkMembers(view, afterInterfaces, () => {});

        let found: string | undefined;
        walkMembers(view, afterFields, (nameIndex, dataOffset) => {
            if (found === undefined && nameIndex === pool.codeIndex) {
                // the code follows the maximum stack, the maximum locals and the code's length
                const codeOffset = dataOffset + 8;
                found = findSwitchInCode(bytes.subarray(codeOffset, codeOffset + view.getUint32(dataOffset + 4)));
            }
        });

        return found;
    } catch (error) {
        if (error instanceof RangeError) {
            return undefined;
        }

        throw error;
    }
}
