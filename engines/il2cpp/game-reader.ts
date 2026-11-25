import { failed, ok, type Reply } from '#contract/reply';
import type { Game, GameField, GameMethod, GameProperty, GameType, TypeReference } from './game';

const decoder = new TextDecoder();

/** Reads the bytes that `GameWriter.cs` writes, in the same order. */
class GameReader {
    private offset = 0;
    private strings: string[] = [];

    constructor(private readonly bytes: Uint8Array) {}

    readNumber(): number {
        let value = 0;
        let scale = 1;
        let byte: number;
        do {
            byte = this.bytes[this.offset++];
            value += (byte & 0x7f) * scale;
            scale *= 0x80;
        } while (byte & 0x80);

        return value;
    }

    readStringTable(): void {
        this.strings = this.readList(() => {
            const length = this.readNumber();
            const text = decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
            this.offset += length;

            return text;
        });
    }

    readList<Item>(readItem: () => Item): Item[] {
        return Array.from({ length: this.readNumber() }, readItem);
    }

    readString(): string {
        return this.strings[this.readNumber()];
    }

    readOptionalString(): string | null {
        const index = this.readNumber();

        return index === 0 ? null : this.strings[index - 1];
    }

    readReference(): TypeReference | null {
        const index = this.readNumber();

        return index === 0 ? null : { name: this.strings[index - 1], definition: this.readNumber() - 1 };
    }

    readGame(): Game {
        const fileVersion = this.readNumber();
        const layout = this.readString();
        const isLayoutGuessed = this.readNumber() === 1;
        const unityVersion = this.readString();
        const pointerSize = this.readNumber();
        const images = this.readList(() => ({ name: this.readString(), firstType: this.readNumber(), typeCount: this.readNumber() }));
        const types = this.readList(() => this.readType());
        const strings = this.readList(() => this.readString());
        const globals = this.readList(() => ({
            rva: this.readNumber(),
            kind: this.readNumber(),
            name: this.readString(),
            definition: this.readNumber() - 1,
            member: this.readNumber() - 1,
            text: this.readString(),
            typeStart: this.readNumber(),
            typeLength: this.readNumber(),
            parts: this.readList(() => ({
                start: this.readNumber(),
                length: this.readNumber(),
                definition: this.readNumber() - 1,
                isMember: this.readNumber() === 1,
            })),
        }));

        return { fileVersion, layout, isLayoutGuessed, unityVersion, pointerSize, images, types, strings, globals };
    }

    readType(): GameType {
        const namespace = this.readString();
        const name = this.readString();
        const declaringType = this.readNumber() - 1;
        const flags = this.readNumber();
        const kind = this.readNumber();
        const genericParameters = this.readList(() => this.readString());
        const baseType = this.readReference();
        const fields = this.readList(() => this.readField());
        const methods = this.readList(() => this.readMethod());
        const properties = this.readList(() => this.readProperty());
        const isValueType = (kind & 1) !== 0;
        const isEnum = (kind & 2) !== 0;

        return {
            namespace,
            name,
            declaringType,
            flags,
            isValueType,
            isEnum,
            genericParameters,
            baseType,
            fields,
            methods,
            properties,
        };
    }

    readField(): GameField {
        const name = this.readString();
        const type = this.readReference();
        const flags = this.readNumber();
        const offset = this.readNumber();
        const value = this.readOptionalString();

        return { name, type, flags: flags === 0 ? null : flags - 1, offset: offset === 0 ? null : offset - 2, value };
    }

    readMethod(): GameMethod {
        const name = this.readString();
        const flags = this.readNumber();
        const returnType = this.readReference();
        const parameters = this.readList(() => ({ name: this.readString(), type: this.readReference() }));
        const genericParameters = this.readList(() => this.readString());
        const rva = this.readNumber();

        return { name, flags, returnType, parameters, genericParameters, rva: rva === 0 ? null : rva - 1 };
    }

    readProperty(): GameProperty {
        const name = this.readString();
        const getter = this.readNumber() - 1;

        return { name, getter, setter: this.readNumber() - 1 };
    }
}

/** Reads the reply of an export that reads a game, which `GameWriter.cs` writes as bytes. */
export function readGameReply(bytes: Uint8Array): Reply<Game> {
    if (bytes[0] === 1) {
        return failed(decoder.decode(bytes.subarray(1)));
    }

    const reader = new GameReader(bytes.subarray(1));
    reader.readStringTable();

    return ok(reader.readGame());
}
