/** The tags in bits 24 to 30 of the keys of rows that don't have an address. */
export const keyTags = {
    /** `Imports` with index 0, and the library of an import with the library's index plus 1. */
    imports: 1,
    importedSymbol: 2,
    namespace: 3,
    class: 4,
} as const;

// the size of an image whose offsets fit into 31 bits, which leaves bit 31 to the keys with a tag
const maxImageSpan = 2n ** 31n;

/** Returns the key of a row without an address, with bit 31 set, the tag in bits 24 to 30 and the index below. */
export function tagKey(tag: number, index: number): number {
    return (0x80000000 | (tag << 24) | index) | 0;
}

/** The keys of the functions and globals of a file by their addresses, and their addresses by the keys. */
export interface AddressKeys {
    keys: Map<bigint, number>;
    addresses: Map<number, bigint>;
}

/**
 * Picks the keys of the functions and globals at the addresses: the offset from the image base while each offset fits
 * into 31 bits, else the index in address order. Keys then depend only on the file, so they stay the same after a
 * worker restart.
 */
export function readAddressKeys(addresses: bigint[], base: bigint): AddressKeys {
    const sorted = [...new Set(addresses)].sort((first, second) => (first < second ? -1 : first > second ? 1 : 0));
    const isOffset = sorted.every(address => address >= base && address - base < maxImageSpan);
    const keys = new Map(sorted.map((address, index) => [address, isOffset ? Number(address - base) : index]));

    return { keys, addresses: new Map([...keys].map(([address, key]) => [key, address])) };
}
