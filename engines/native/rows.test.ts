import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRows, type Row } from '#contract/rows';
import { serveEngine, type WorkerMessage, type WorkerPort } from '#contract/serve';
import { accessibilityOf, modifiersOf } from '#contract/symbols';
import { LoadError } from '../shared/loading';
import { moduleFolder } from './build/link';
import { mountInMemory } from './files';
import { createNativeHandlers } from './handlers';
import { loadModule, type NativeModule } from './module';
import { groupRows, type GlueListing } from './rows';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

// writes each row as its kind, its path like `geometry::Rect::area` and its flags
function describeRows(rows: Row[]): string[] {
    const paths: string[] = [];
    for (const { name, parent } of rows) {
        paths.push(parent < 0 ? name : `${paths[parent]}::${name}`);
    }

    return rows.map(({ kind, flags }, index) => [kind, paths[index], accessibilityOf(flags), ...modifiersOf(flags)].filter(Boolean).join(' '));
}

async function listFile(name: string): Promise<Row[]> {
    const engine = connect();
    const file = await readFixture(name);
    const fileId = await engine.open(file.name, file);
    const listing = await engine.list(fileId);
    await engine.close(fileId);

    return readRows(listing);
}

// returns a listing of the functions, without globals, imports, types, classes or a PDB file
function listFunctions(functions: GlueListing['functions']): GlueListing {
    return {
        base: '0x0',
        functions,
        data: [],
        imports: [],
        types: [],
        classes: [],
        pdb: '',
        hasPdb: false,
        omitted: 0,
        omittedImports: 0,
        strings: 0,
    };
}

// lists a class `big::Big` with methods of the given sizes, whose constructor makes `Big` a class
function listBigClass(sizes: number[]): Row[] {
    const listing: GlueListing = {
        ...listFunctions([]),
        base: '0x1000',
        functions: [
            { addr: '0x2000', size: 8, name: 'big::Big::Big()', global: true },
            ...sizes.map((size, index) => ({
                addr: `0x${(0x10000 + index * 0x20000).toString(16)}`,
                size,
                name: `big::Big::m${index}()`,
                global: true,
            })),
        ],
    };

    return groupRows(listing).rows;
}

// lists the symbols of a fixture's file with the module, with at most `maxMembers` functions and globals
async function listSymbols(name: string, maxMembers: number): Promise<GlueListing> {
    const module = await loadTestModule();
    module.fs.mkdirTree('/cap');
    module.fs.writeFile(`/cap/${name}`, await (await readFixture(name)).bytes());

    const session = module.newSession();
    module.openSession(session, `/cap/${name}`);
    const listing = module.listSymbols(session, maxMembers);
    module.freeSession(session);
    module.fs.unlink(`/cap/${name}`);

    return listing;
}

test('shapes-x64.so lists geometry, Rect with its methods, the free functions and Imports', async () => {
    expect(describeRows(await listFile('shapes-x64.so'))).toEqual([
        'section Imports',
        'field Imports::vtable for __cxxabiv1::__class_type_info public extern',
        'field Imports::vtable for __cxxabiv1::__si_class_type_info public extern',
        'namespace geometry',
        'class geometry::Circle document',
        'method geometry::Circle::sides',
        'method geometry::Circle::scaled',
        'class geometry::Rect document',
        'class geometry::Rect::Corner document',
        'method geometry::Rect::Corner::distance',
        'method geometry::Rect::area',
        'method geometry::Rect::corner',
        'field geometry::Rect::count static',
        'class geometry::Shape document',
        'method geometry::Shape::sides',
        'method geometry::Shape::scaled',
        'method add public document',
        'method add_twice public document',
        'method rect_area public document',
        'method classify document static',
        'method circle_sides public document',
        'method fixture_name public document',
        'method add_swapped public document',
        'method count_down public document',
        'field shape_total public',
    ]);
});

test('a class within the budget has the document and its methods don\'t', () => {
    expect(describeRows(listBigClass([100, 200]))).toEqual([
        'namespace big',
        'class big::Big document',
        'constructor big::Big::Big',
        'method big::Big::m0',
        'method big::Big::m1',
    ]);
});

test('a class above the budget leaves the document to each method', () => {
    const tooLarge = describeRows(listBigClass([60 * 1024, 5 * 1024]));
    const tooMany = describeRows(listBigClass(Array.from({ length: 100 }, () => 16)));

    expect(tooLarge).toEqual([
        'namespace big',
        'class big::Big',
        'constructor big::Big::Big document',
        'method big::Big::m0 document',
        'method big::Big::m1 document',
    ]);
    expect(tooMany[1]).toBe('class big::Big');
    expect(tooMany.slice(2).every(row => row.endsWith(' document'))).toBe(true);
});

test('a listing above the cap leaves out the functions with the highest addresses and says so in the note', () => {
    const listing = listFunctions(['0x30', '0x10', '0x20'].map((addr, index) => ({ addr, size: 4, name: `f${index}`, global: true })));
    const { rows, note } = groupRows(listing, 2);

    expect(rows.map(row => row.name)).toEqual(['f1', 'f2']);
    expect(note).toBe('Lists 2 of 3 functions and globals.');
});

test('the glue lists the functions, globals and imports up to the cap, those with the lowest addresses, and counts the others', async () => {
    const full = await listSymbols('shapes-x64.so', 1000);
    const capped = await listSymbols('shapes-x64.so', 1);
    const addresses = ({ functions, data }: GlueListing) => {
        return [...functions, ...data].map(({ addr }) => BigInt(addr)).sort((first, second) => (first < second ? -1 : 1));
    };

    expect(addresses(capped)).toEqual(addresses(full).slice(0, 1));
    expect(capped.omitted).toBe(addresses(full).length - 1);
    expect(capped.imports).toEqual(full.imports.slice(0, 1));
    expect(capped.omittedImports).toBe(full.imports.length - 1);
    expect([full.omitted, full.omittedImports]).toEqual([0, 0]);
});

test('the note counts the functions, globals and imports that the glue left out', () => {
    const imports = [{ name: 'puts', library: 'libc.so.6', function: true }];
    const functions = [{ addr: '0x10', size: 4, name: 'f', global: true }];
    const { rows, note } = groupRows({ ...listFunctions(functions), imports, omitted: 4, omittedImports: 2 });

    expect(note).toBe('Lists 1 of 5 functions and globals. Lists 1 of 3 imports.');
    expect(rows[0]).toMatchObject({ name: 'Imports', detail: '3' });
});

test("a listing above the size of a JavaScript string becomes a failed reply", async () => {
    const module = await loadTestModule();
    const broken: NativeModule = {
        ...module,
        listSymbols() {
            throw new LoadError("The native engine couldn't read the symbols of the file.");
        },
    };
    const handlers = createNativeHandlers(async () => broken, mountInMemory);
    const file = await readFixture('shapes-x64.so');
    const signal = new AbortController().signal;
    await handlers.open(1, file.name, file, signal);

    expect(await handlers.list(1, signal)).toEqual({ error: "The native engine couldn't read the symbols of the file." });
}, 120000);

// loads Rizin from a wrapper whose listing call traps like an out-of-bounds read, so the trap passes the module's own
// reading of the listing
async function loadTrappingModule(): Promise<NativeModule> {
    const wrapper = join(moduleFolder, '..', 'native-test', 'trapping-rizin.mjs');
    await Bun.write(wrapper, [
        `import createRizin from ${JSON.stringify(pathToFileURL(join(moduleFolder, 'rizin.mjs')).href)};`,
        'export default async options => {',
        '    const module = await createRizin(options);',
        "    module._session_listing = () => { throw new WebAssembly.RuntimeError('memory access out of bounds'); };",
        '    return module;',
        '};',
    ].join('\n'));

    const module = await loadModule(pathToFileURL(wrapper).href, await Bun.file(join(moduleFolder, 'rizin.wasm')).arrayBuffer());

    // fetches the databases and languages through the real module because they sit beside the real `rizin.mjs`
    return { ...module, fetchFile: (await loadTestModule()).fetchFile };
}

test('a trap in a listing reaches the queue as fatal, so the queue restarts the worker', async () => {
    const trapping = await loadTrappingModule();
    const sent: WorkerMessage[] = [];
    const port: WorkerPort = { onmessage: null, postMessage: message => sent.push(message) };
    serveEngine(port, createNativeHandlers(async () => trapping, mountInMemory));
    const file = await readFixture('shapes-x64.so');

    await port.onmessage?.(new MessageEvent('message', { data: { method: 'open', args: [1, file.name, file] } }));
    await port.onmessage?.(new MessageEvent('message', { data: { method: 'list', args: [1] } }));

    expect(sent.at(-1)).toEqual({ fatal: 'memory access out of bounds' });
}, 120000);

test('a class of methods without a known size counts each as 1 kb', () => {
    expect(describeRows(listBigClass(Array.from({ length: 63 }, () => 0)))[1]).toBe('class big::Big document');
    expect(describeRows(listBigClass(Array.from({ length: 64 }, () => 0)))[1]).toBe('class big::Big');
});

test('extras-x64.so lists privately as a namespace, whose name only starts like an access', async () => {
    const rows = describeRows(await listFile('extras-x64.so'));

    expect(rows).toContain('namespace privately');
    expect(rows).toContain('method privately::helper public document');
});

test('keys stay the same in a second session', async () => {
    const first = await listFile('shapes-x64.so');
    const second = await listFile('shapes-x64.so');
    const keys = first.map(row => row.key);

    expect(second.map(row => row.key)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(first.find(row => row.name === 'add')?.key).toBe(0x1a20);
});

test('keys stay the same with a fresh module in another process', async () => {
    const keys = (await listFile('shapes-x64.so')).map(row => row.key);
    const testing = fileURLToPath(new URL('testing.ts', import.meta.url));
    const script = `
        import { listKeys } from ${JSON.stringify(testing)};
        console.log(JSON.stringify(await listKeys('shapes-x64.so')));
    `;
    const { exitCode, stdout } = Bun.spawnSync([process.execPath, '-e', script], { env: process.env });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.toString())).toEqual(keys);
}, 120000);
