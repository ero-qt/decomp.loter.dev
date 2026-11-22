import { expect, test } from 'bun:test';

interface Rule {
    name?: string;
    match?: string;
    begin?: string;
    end?: string;
    captures?: Record<string, { name: string }>;
}

const grammar: { scopeName: string; repository: Record<string, Rule> } = await Bun.file(
    new URL('grammars/listing.tmLanguage.json', import.meta.url),
).json();

// returns the text that a rule of the grammar colors in a line, with the scope that it gives the text
function colorText(ruleName: string, line: string): [text: string, scope: string] | undefined {
    const { name, match, begin, captures } = grammar.repository[ruleName];
    const found = new RegExp(match ?? begin!).exec(line);
    if (!found) {
        return undefined;
    }

    return captures ? [found[1], captures['1'].name] : [found[0], name!];
}

test("listing grammar colors a line's first word as an opcode after its line number and offset", () => {
    expect(grammar.scopeName).toBe('source.listing');
    expect(colorText('opcode', '  2           0 LOAD_CONST               1 (2)')).toEqual(['LOAD_CONST', 'support.function.opcode.listing']);
    expect(colorText('opcode', '0x1f: pushi.e 4')).toEqual(['pushi.e', 'support.function.opcode.listing']);
    expect(colorText('opcode', 'add r1, r2')).toEqual(['add', 'support.function.opcode.listing']);
});

test('listing grammar colors comments, strings and numbers', () => {
    expect(colorText('comment', 'GETTABUP 0 0 -1 ; _ENV "print"')).toEqual(['; _ENV "print"', 'comment.line.listing']);
    expect(colorText('string-double', 'LOADK 1 "a b"')).toEqual(['"', 'string.quoted.double.listing']);
    expect(colorText('string-single', "LOAD_CONST 'x'")).toEqual(["'", 'string.quoted.single.listing']);
    expect(colorText('number-hex', 'jmp 0x1F')).toEqual(['0x1F', 'constant.numeric.hex.listing']);
    expect(colorText('number', 'LOADI -12')).toEqual(['-12', 'constant.numeric.listing']);
});

test('listing grammar ends a string at its closing quote or at the line end', () => {
    for (const ruleName of ['string-double', 'string-single']) {
        const end = new RegExp(grammar.repository[ruleName].end!, 'g');
        const quote = ruleName === 'string-double' ? '"' : "'";

        expect([...`a b${quote} c`.matchAll(end)].map(match => match.index)).toEqual([3, 6]);
    }
});
