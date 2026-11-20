import { expect, test } from 'bun:test';
import { readAddressKeys } from './keys';

test('keys are the offsets from a non-zero image base', () => {
    const { keys, addresses } = readAddressKeys([0x401020n, 0x401000n], 0x400000n);

    expect([...keys]).toEqual([
        [0x401000n, 0x1000],
        [0x401020n, 0x1020],
    ]);
    expect(addresses.get(0x1020)).toBe(0x401020n);
});

test('an image that spans 2 gb or more numbers its keys in address order', () => {
    const { keys } = readAddressKeys([0x80001000n, 0x1000n, 0x2000n], 0n);

    expect([...keys]).toEqual([
        [0x1000n, 0],
        [0x2000n, 1],
        [0x80001000n, 2],
    ]);
});
