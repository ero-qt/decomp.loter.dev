import { toHex } from '#contract/manifest';

export { toHex } from '#contract/manifest';

/** Reads the first bytes of a file up to the count, never the rest, and returns them as hex. */
export async function readStartHex(file: Blob, byteCount: number): Promise<string> {
    return toHex(await file.slice(0, byteCount).bytes());
}
