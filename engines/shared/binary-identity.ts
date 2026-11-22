import { toHex } from './magic';

/**
 * Represents a binary's size and SHA-256 hash in hex, which a names file has because the names' addresses only fit that
 * binary.
 */
export interface BinaryIdentity {
    Size: number;
    Sha256: string;
}

/** Reads a binary's size and SHA-256 hash. */
export async function readBinaryIdentity(binary: Blob): Promise<BinaryIdentity> {
    return hashBinary(await binary.bytes());
}

/** Returns the size and SHA-256 hash of a binary's bytes, which the caller read already. */
export async function hashBinary(bytes: Uint8Array<ArrayBuffer>): Promise<BinaryIdentity> {
    const hash = await crypto.subtle.digest('SHA-256', bytes);

    return { Size: bytes.length, Sha256: toHex(new Uint8Array(hash)) };
}

/** Returns whether a binary has the size and hash, and only hashes the binary when the size fits. */
export async function matchesBinary(identity: BinaryIdentity, binary: Blob): Promise<boolean> {
    return identity.Size === binary.size && identity.Sha256 === (await readBinaryIdentity(binary)).Sha256;
}

/** Returns whether a value is a binary's size and hash in hex. */
export function isBinaryIdentity(value: unknown): value is BinaryIdentity {
    const identity = value as Partial<BinaryIdentity> | null;

    return Number.isSafeInteger(identity?.Size) && typeof identity?.Sha256 === 'string' && /^[0-9a-f]{64}$/.test(identity.Sha256);
}
