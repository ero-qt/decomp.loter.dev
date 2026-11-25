import { tryParseType } from '@katana-project/asm/type';
import { expect, test } from 'bun:test';
import { writeType } from './types';

// parses a list of lists nested the count of levels deep, like `List<List<String>>` for 2
function parseNested(levels: number) {
    return tryParseType(`${'Ljava/util/List<'.repeat(levels)}Ljava/lang/String;${'>;'.repeat(levels)}`)!;
}

test('writeType writes a generic type nested 50 levels deep and refuses one nested deeper than 100 levels', () => {
    expect(writeType(parseNested(50))).toBe(`${'List<'.repeat(50)}String${'>'.repeat(50)}`);
    expect(() => writeType(parseNested(101))).toThrow("The engine can't write a type nested more than 100 levels deep.");
});
