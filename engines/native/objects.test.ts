import { expect, test } from 'bun:test';
import type { Engine } from '../../contract/engine';
import { findDocumentRow, readRows, type Row } from '../../contract/rows';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

interface OpenFile {
    engine: Engine;
    fileId: number;
    rows: Row[];
}

async function openFile(name: string): Promise<OpenFile> {
    const engine = connect();
    const file = await readFixture(name);
    const fileId = await engine.open(file.name, file);

    return { engine, fileId, rows: readRows(await engine.list(fileId)) };
}

// reads the document of a function's row from the signature on, or the whole document without the signature, because
// a method's document is its class's document
async function readCode(file: OpenFile, name: string, signature: string): Promise<string> {
    const index = file.rows.findIndex(candidate => candidate.name === name);
    const documentRow = file.rows[findDocumentRow(file.rows, index) ?? -1];
    if (!documentRow) {
        throw new Error(`the file doesn't have a document for ${name}`);
    }

    const { text } = await file.engine.read(file.fileId, documentRow.key, 'c');
    const start = text.indexOf(signature);

    return start < 0 ? text : text.slice(start);
}

// matches a line that starts a function's definition or prototype with the name, because comments and statements
// start with an indent
function findDefinition(name: string): RegExp {
    return new RegExp(`^\\S[^\\n]* ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(`, 'm');
}

// pins the store of Circle's vtable pointer by the label of the vtable's slot for sides, which is where the pointer
// points in an object without a GOT
test("the C of x86-64 and i386 objects reads count, shape_total and Circle's vtable through their GOT relocations", async () => {
    for (const name of ['shapes-x64.o', 'shapes-x86.o']) {
        const file = await openFile(name);
        const area = await readCode(file, 'area', 'geometry::Rect::area(');
        const rectArea = await readCode(file, 'rect_area', 'rect_area(');
        const circleSides = await readCode(file, 'circle_sides', 'circle_sides(');

        expect(area).toContain('geometry::Rect::count');
        expect(rectArea).toMatch(/shape_total = .*shape_total \+ 1;/);
        expect(circleSides).toMatch(/ = (\(int32_t\))?reloc\.geometry::Circle::sides\(\) const;/);
        expect([area, rectArea, circleSides].join('\n')).not.toMatch(/0x[0-9a-f]{12,}/);
    }
}, 120000);

test("the C of objects names each function after its symbol, not after its section or an ARM mapping symbol", async () => {
    for (const [name, row, function_, caller] of [
        ['shapes-x86.o', 'area', 'geometry::Rect::area', 'rect_area'],
        ['shapes-a64.o', 'area', 'geometry::Rect::area', 'rect_area'],
        ['extras-x64.o', 'scale', 'extras::scale', 'scale_twice'],
        ['big-x64.o', 'big_sum', 'big_sum', 'big_sum'],
    ]) {
        const file = await openFile(name);
        const code = await readCode(file, row, '');
        const callerCode = await readCode(file, caller, `${caller}(`);

        expect(code).toMatch(findDefinition(function_));
        expect(callerCode).toContain(`${function_}(`);
        expect([code, callerCode].join('\n')).not.toMatch(/(\.text|\$[adtx])\(/);
    }
}, 120000);
