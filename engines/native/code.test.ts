import { expect, test } from 'bun:test';
import { readTokens } from '../../contract/document';
import { flagsOf, modifiersOf } from '../../contract/symbols';
import { type Annotation, type CodeRows, writeCode, writePrototype } from './code';

// a word of the C to annotate in order: the word, its highlight and the annotation that gives its name or address
type Mark = [word: string, highlight: string, detail?: Omit<Annotation, 'start' | 'end'>];

const rows: CodeRows = {
    fileId: 3,
    address: 0x1a30n,
    findRow: address => (address === 0x1a30n ? { key: 0x1a30, kind: 'method' } : address === 0x1a20n ? { key: 0x1a20, kind: 'method' } : undefined),
};

// annotates each word at its next place after the last word, with UTF-8 offsets like rz-ghidra
function annotate(code: string, marks: Mark[]): Annotation[] {
    const annotations: Annotation[] = [];
    let from = 0;
    for (const [word, highlight, detail] of marks) {
        const index = code.indexOf(word, from);
        const start = Buffer.byteLength(code.slice(0, index));
        const end = start + Buffer.byteLength(word);
        annotations.push({ start, end, type: 'syntax_highlight', syntax_highlight: highlight });
        if (detail) {
            annotations.push({ start, end, ...detail });
        }

        from = index + word.length;
    }

    return annotations;
}

function describeTokens(code: string, annotations: Annotation[]): string[] {
    const document = writeCode(code, annotations, rows);

    return readTokens(document).map(({ start, length, kind, flags, target }) => {
        return [document.text.slice(start, start + length), kind, ...modifiersOf(flags), target ?? ''].filter(Boolean).join(' ');
    });
}

const addTwice = '\nvoid add_twice(int left, int right)\n{\n    undefined4 sum;\n    \n    sum = add(left, right);\n    return;\n}\n';
const addTwiceMarks: Mark[] = [
    ['void', 'datatype'],
    ['add_twice', 'function_name', { type: 'function_name', name: 'add_twice', offset: '0x1a30' }],
    ['int', 'datatype'],
    ['left', 'function_parameter', { type: 'function_parameter', name: 'left' }],
    ['int', 'datatype'],
    ['right', 'function_parameter', { type: 'function_parameter', name: 'right' }],
    ['undefined4', 'datatype'],
    ['sum', 'local_variable', { type: 'local_variable', name: 'sum' }],
    ['sum', 'local_variable', { type: 'local_variable', name: 'sum' }],
    ['add', 'function_name', { type: 'function_name', name: 'add', offset: '0x1a20' }],
    ['left', 'function_parameter', { type: 'function_parameter', name: 'left' }],
    ['right', 'function_parameter', { type: 'function_parameter', name: 'right' }],
    ['return', 'keyword'],
];

test("code declares the function, numbers its parameters and locals and points a call at its callee's row", () => {
    const document = writeCode(addTwice, annotate(addTwice, addTwiceMarks), rows);

    expect(document.text.startsWith('void add_twice(int left, int right)\n')).toBe(true);
    expect(document.locals).toEqual(['int left', 'int right', 'undefined4 sum']);
    expect(describeTokens(addTwice, annotate(addTwice, addTwiceMarks))).toEqual([
        'void struct',
        'add_twice method declaration 3:1a30',
        'int struct',
        'left parameter declaration L:0',
        'int struct',
        'right parameter declaration L:1',
        'undefined4 struct',
        'sum local declaration L:2',
        'sum local L:2',
        'add method 3:1a20',
        'left parameter L:0',
        'right parameter L:1',
    ]);
});

test("a goto points at its label's line, which declares the label", () => {
    const code = 'void count_down(int value)\n{\n    if (10 < value) goto loc_1b3e;\n    value = value + -3;\nloc_1b3e:\n    return;\n}\n';
    const marks: Mark[] = [['if', 'keyword'], ['goto', 'keyword']];

    expect(describeTokens(code, annotate(code, marks))).toEqual(['loc_1b3e label L:0', 'loc_1b3e label declaration L:0']);
    expect(writeCode(code, annotate(code, marks), rows).locals).toEqual(['loc_1b3e']);
});

test('warnings move from the top of the c to a block at its end', () => {
    const code = '// WARNING: Removing unreachable block\n\nvoid f(void)\n{\n    return;\n}\n';
    const marks: Mark[] = [['//', 'comment'], ['WARNING:', 'comment'], ['void', 'datatype']];

    expect(writeCode(code, annotate(code, marks), rows).text).toBe('void f(void)\n{\n    return;\n}\n\n// WARNING: Removing unreachable block\n');
});

test('token offsets count utf-16 code units after other characters', () => {
    const code = 'void f(void)\n{\n    puts("größe");\n    next();\n}\n';
    const marks: Mark[] = [['void', 'datatype'], ['next', 'function_name', { type: 'function_name', name: 'next', offset: '0x1a20' }]];

    expect(describeTokens(code, annotate(code, marks))).toEqual(['void struct', 'next method 3:1a20']);
});

test("a prototype declares its function's name, also when its return type has the name", () => {
    const document = writePrototype('struct big *big(int value);', 'big', 70112, rows, 'method');

    expect(readTokens(document)[0]).toMatchObject({ start: 12, length: 3 });
});

test('a prototype declares its function and gives the size of its code', () => {
    const document = writePrototype('int big_sum(int value);', 'big_sum', 70112, rows, 'method');

    expect(document.text).toBe('int big_sum(int value);\n// 70,112 bytes of code, more than the engine decompiles.\n');
    expect(readTokens(document)).toEqual([{ start: 4, length: 7, kind: 'method', flags: flagsOf('', 'declaration'), target: '3:1a30' }]);
});
