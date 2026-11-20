import { failed, ok, type Reply } from '../../contract/reply';

/** A reply as the C# exports write it, with `null` for the missing field. */
interface ExportReply<Value> {
    value: Value | null;
    error: string | null;
}

/** Reads the JSON reply of a C# export. */
export function readReply<Value>(json: string): Reply<Value> {
    const { value, error }: ExportReply<Value> = JSON.parse(json);

    return error === null ? ok(value as Value) : failed(error);
}

/** Reads the JSON reply of a C# export without a value. */
export function readVoidReply(json: string): Reply<void> {
    const reply = readReply<boolean>(json);

    return reply.error === undefined ? ok(undefined) : reply;
}

/** Reads the base64 of little-endian 32-bit integers, the shape in which the C# exports write rows and tokens. */
export function readInt32s(base64: string): Int32Array {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) {
        bytes[index] = text.charCodeAt(index);
    }

    const view = new DataView(bytes.buffer);
    const values = new Int32Array(bytes.length / 4);
    for (let index = 0; index < values.length; index++) {
        values[index] = view.getInt32(index * 4, true);
    }

    return values;
}
