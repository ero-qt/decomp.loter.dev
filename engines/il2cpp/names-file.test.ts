import { expect, test } from 'bun:test';
import { nameStructs } from './c-types';
import { listClassStructs, plainClassStruct } from './class-structs';
import { type Game, globalKinds } from './game';
import { writeNativeNames } from './names-file';
import { loadTestRuntime, readCodeGame, readFixture, readGame, readOlderLayout } from './testing';

const runtime = await loadTestRuntime();

async function readFixtureGame(): Promise<Game> {
    return readGame(runtime, await (await readFixture('global-metadata.dat')).bytes(), await (await readFixture('GameAssembly.dll')).bytes());
}

async function readBuild(read: (name: string) => Promise<File>): Promise<Game> {
    return readGame(runtime, await (await read('global-metadata.dat')).bytes(), await (await read('GameAssembly.dll')).bytes());
}

// writes the lines of a game's methods and the header with the structs of every method's signature
async function writeNames(game: Game): Promise<{ lines: string[]; header: string }> {
    const names = writeNativeNames(game);
    const rvas = game.types.flatMap(type => type.methods.flatMap(method => (method.rva === null ? [] : [method.rva])));

    return { lines: (await names.lines.text()).split('\n'), header: names.writeTypes(rvas).header };
}

function findMethod(game: Game, typeName: string, methodName: string) {
    return game.types.find(type => type.name === typeName)!.methods.find(method => method.name === methodName)!;
}

test('the names have a line with the address, name, C signature and C# record of each method with code', async () => {
    const game = await readFixtureGame();
    const { lines } = await writeNames(game);
    const area = findMethod(game, 'Circle', 'Area').rva!.toString(16);
    const unit = findMethod(game, 'Circle', 'Unit').rva!.toString(16);

    expect(lines).toContain(`${area} Shapes.Circle$$Area\tfloat Circle__Area(struct Circle_o *__this, void *method)\t0i0\tCircle\tArea`);
    expect(lines).toContain(`${unit} Shapes.Circle$$Unit\tstruct Circle_o *Circle__Unit(void *method)\t0s0\tCircle\tUnit`);
    expect(lines.some(line => line.includes('Shapes.Circle.Builder$$Build\t'))).toBe(true);
    expect(lines.some(line => line.includes('Shapes.Shape$$Area'))).toBe(false);
});

test("the header has the structs of the classes with their fields' offsets", async () => {
    const { header } = await writeNames(await readFixtureGame());

    // Circle's `radius` sits at 0x18 after the object's header of 2 pointers and the field `name` of its base class
    expect(header).toContain('struct Circle_o {\n    void *klass;\n    void *monitor;\n    struct String_o *name;\n    float radius;\n};\n');
});

test("the header gives a struct's fields names that C takes, apart from each other", async () => {
    const game = await readFixtureGame();
    const fieldOf = (typeName: string) => game.types.find(type => type.name === typeName)!.fields[0];
    // names both fields `register`, a word that C reserves, which Circle's struct then has twice
    fieldOf('Shape').name = 'register';
    fieldOf('Circle').name = 'register';

    const { header } = await writeNames(game);

    const circle = 'struct Circle_o {\n    void *klass;\n    void *monitor;\n    struct String_o *register_;\n    float register__2;\n};\n';
    expect(header).toContain(circle);
});

test("the header gives an array field the struct of the array's objects and a struct field its struct's size", async () => {
    const game = await readFixtureGame();
    const indexOf = (typeName: string) => game.types.findIndex(type => type.name === typeName);
    const [circle, point] = [game.types[indexOf('Circle')], game.types[indexOf('Point')]];
    // gives Circle an array of the enum Color for its `radius` and a Point after it, with a 3rd int for Point
    const radius = circle.fields[0];
    radius.type = { name: 'Color[]', definition: indexOf('Color') };
    circle.fields.push({ ...radius, name: 'origin', type: { name: 'Point', definition: indexOf('Point') }, offset: radius.offset! + 8 });
    point.fields.push({ ...point.fields[1], name: 'z', offset: point.fields[1].offset! + 4 });

    const { header } = await writeNames(game);

    const colors = `Color_${indexOf('Color')}_array`;
    const members = `    struct String_o *name;\n    struct ${colors} *radius;\n    uint8_t origin[12];\n};\n`;
    expect(header).toContain(`struct Circle_o {\n    void *klass;\n    void *monitor;\n${members}`);
    const items = '    void *bounds;\n    int32_t max_length;\n    uint8_t _gap_1c[4];\n    int32_t items[1];\n};\n';
    expect(header).toContain(`struct ${colors} {\n    void *klass;\n    void *monitor;\n${items}`);
});

test("the header gives an array of a generic parameter a pointer, because the items' size depends on the argument", async () => {
    const game = await readFixtureGame();
    const circle = game.types.find(type => type.name === 'Circle')!;
    circle.fields[0].type = { name: 'T[]', definition: -1 };

    const { header } = await writeNames(game);

    expect(header).toContain('    struct String_o *name;\n    void *radius;\n};\n');
});

test('the names leave the control characters out of a name', async () => {
    const game = await readFixtureGame();
    findMethod(game, 'Circle', 'Area').name = 'Area\n\t\u0000Injected';

    const { lines } = await writeNames(game);

    expect(lines.some(line => line.includes(' Shapes.Circle$$AreaInjected\t'))).toBe(true);
});

test('il2cpp engine finds the metadata globals of a libil2cpp.so without section headers in its writable segment', async () => {
    const metadata = await (await readFixture('global-metadata.dat')).bytes();
    const binary = await (await readFixture('libil2cpp.so')).bytes();
    // drops the section headers like some Android builds do, by the count at 0x3c of a 64-bit ELF header
    const stripped = binary.slice();
    new DataView(stripped.buffer).setUint16(0x3c, 0, true);
    const readGlobals = (bytes: Uint8Array) => readGame(runtime, metadata, bytes, 'libil2cpp.so').globals;
    const globals = readGlobals(binary);

    expect(globals.length).toBeGreaterThan(0);
    expect(readGlobals(stripped)).toEqual(globals);
});

test("the header types a method's global as IL2CPP's MethodInfo, with the class after the method's 3 pointers", async () => {
    const game = await readBuild(readCodeGame);
    const global = game.globals.find(found => found.kind === globalKinds.methodDef)!;

    const { header, globals } = writeNativeNames(game).writeTypes([global.rva]);

    expect(globals).toContain(`@${global.rva.toString(16)} Method$Shapes.Square..ctor()\tstruct MethodInfo *\t`);
    const pointers = '    void *methodPointer;\n    void *virtualMethodPointer;\n    void *invoker_method;\n    void *name;\n';
    expect(header).toContain(`struct MethodInfo {\n${pointers}    struct Il2CppClass *klass;\n`);
});

test("the header has the bit fields of a version 31 class after the class's sizes, counts and alignments", async () => {
    const game = await readBuild(readCodeGame);
    const global = game.globals.find(found => found.kind === globalKinds.typeInfo)!;

    const { header } = writeNativeNames(game).writeTypes([global.rva]);

    // the bit fields start at 0x135, where a 2022.3 build tests the bit of `initialized_and_no_error`
    const sizes = '    uint32_t instance_size;\n    uint32_t stack_slot_size;\n    uint32_t actualSize;\n';
    const alignments = '    uint8_t minimumAlignment;\n    uint8_t packingSize;\n    uint8_t bitflags1;\n';
    expect(header).toContain(`    uint64_t cctor_thread;\n    void *genericContainerHandle;\n${sizes}`);
    expect(header).toContain(`    uint8_t rank;\n${alignments}`);
});

test("the header has the natural alignment of a version 29 class, which version 31 trades for the stack slot's size", async () => {
    const game = await readBuild(readOlderLayout);

    const header = listClassStructs(nameStructs(game, game.pointerSize)).structs.get(plainClassStruct)!();

    expect(header).toContain('    uint8_t minimumAlignment;\n    uint8_t naturalAligment;\n    uint8_t packingSize;\n    uint8_t bitflags1;\n');
    expect(header).toContain('    uint32_t instance_size;\n    uint32_t actualSize;\n');
});
