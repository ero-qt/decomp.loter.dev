import { expect, test } from 'bun:test';
import type { Engine } from './engine';
import { readReplyValue } from './replies';

const missingFile = { name: 'app.pdb', reason: 'not loaded', isCompanion: true };
const listing = { values: new Int32Array(), names: [], details: [], note: '', missingFiles: [missingFile] };
const document = { text: 'class A\n', tokens: new Int32Array(), targets: ['1:2'], locals: [] };
const description = { text: 'class A', container: null, facts: [['token', '0x02000002']], missingFile: 'app.pdb' };

const kept: [method: keyof Engine, value: unknown][] = [
    ['claims', false],
    ['list', listing],
    ['read', document],
    ['describe', description],
    ['describe', null],
    ['resolve', '1:2'],
    ['resolve', null],
    ['findReferences', [{ user: '1:2', ranges: null }, { user: '2:3', ranges: new Int32Array([1, 8, 4]) }]],
    ['listStrings', [{ text: 'a', user: '1:2' }, { text: 'b', user: null }]],
    ['open', undefined],
    ['close', 'anything'],
    ['provide', 3],
];

test('readReplyValue returns each value that keeps the contract and every value of open, close and provide', () => {
    for (const [method, value] of kept) {
        expect(readReplyValue(method, value) as unknown).toBe(value);
    }
});

const broken: [subject: string, method: keyof Engine, value: unknown, message: string][] = [
    ["a claim that isn't a boolean", 'claims', 'yes', "the reply of claims isn't a boolean"],
    ["a listing that isn't an object", 'list', [], "the reply of list isn't an object"],
    ['listing values in a plain list', 'list', { ...listing, values: [] }, "the reply of list has values that aren't an Int32Array"],
    ['listing names in a text', 'list', { ...listing, names: 'A' }, "the reply of list has names that aren't a list"],
    ['listing details in a text', 'list', { ...listing, details: 'A' }, "the reply of list has details that aren't a list"],
    ["a listing note that isn't a string", 'list', { ...listing, note: null }, "the reply of list has a note that isn't a string"],
    [
        'a missing file without isCompanion',
        'list',
        { ...listing, missingFiles: [{ name: 'app.pdb', reason: 'not loaded' }] },
        "the reply of list has a missing file that isn't a name, a reason and isCompanion",
    ],
    ["a document text that isn't a string", 'read', { ...document, text: 3 }, "the reply of read has a text that isn't a string"],
    ['document tokens in a plain list', 'read', { ...document, tokens: [] }, "the reply of read has tokens that aren't an Int32Array"],
    ["a document target that isn't a string", 'read', { ...document, targets: [1] }, "the reply of read has targets that aren't a list of strings"],
    ["a document local that isn't a string", 'read', { ...document, locals: [null] }, "the reply of read has locals that aren't a list of strings"],
    ["a description text that isn't a string", 'describe', { ...description, text: 3 }, "the reply of describe has a text that isn't a string"],
    [
        "a description container that isn't a string",
        'describe',
        { ...description, container: 3 },
        "the reply of describe has a container that isn't a string or null",
    ],
    [
        'a fact with 1 string',
        'describe',
        { ...description, facts: [['token']] },
        "the reply of describe has facts that aren't a list of 2 strings each",
    ],
    [
        "a description missing file that isn't a string",
        'describe',
        { ...description, missingFile: 3 },
        "the reply of describe has a missing file that isn't a string or null",
    ],
    ['a resolved local', 'resolve', 'L:0', "the reply of resolve isn't a row target or null"],
    [
        "a user that isn't a target",
        'findReferences',
        [{ user: 'bogus', ranges: null }],
        "the reply of findReferences isn't a list of row targets, each with ranges or null",
    ],
    [
        'ranges in a plain list',
        'findReferences',
        [{ user: '1:2', ranges: [1, 8, 4] }],
        "the reply of findReferences isn't a list of row targets, each with ranges or null",
    ],
    [
        'ranges without a length',
        'findReferences',
        [{ user: '1:2', ranges: new Int32Array([1, 8]) }],
        "the reply of findReferences isn't a list of row targets, each with ranges or null",
    ],
    [
        'empty ranges',
        'findReferences',
        [{ user: '1:2', ranges: new Int32Array() }],
        "the reply of findReferences isn't a list of row targets, each with ranges or null",
    ],
    [
        'a range before the first line',
        'findReferences',
        [{ user: '1:2', ranges: new Int32Array([-1, 8, 4]) }],
        "the reply of findReferences isn't a list of row targets, each with ranges or null",
    ],
    [
        'a string whose user is outside the open files',
        'listStrings',
        [{ text: 'a', user: '|T:A' }],
        "the reply of listStrings isn't a list of texts, each with a row target or null as its user",
    ],
];

for (const [subject, method, value, message] of broken) {
    test(`readReplyValue refuses ${subject}`, () => {
        expect(() => readReplyValue(method, value)).toThrow(message);
    });
}
