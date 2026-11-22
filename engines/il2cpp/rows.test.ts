import { readRows, type Row } from '#contract/rows';
import { accessibilityOf, modifiersOf } from '#contract/symbols';
import { expect, test } from 'bun:test';
import type { Game, GameMethod, GameType } from './game';
import { countMemberStarts, firstKeys, indexCodeMethods, listRows } from './rows';
import { loadTestRuntime, readFixture, useIl2CppEngine } from './testing';

const connect = useIl2CppEngine();
await loadTestRuntime();

// writes a game of 1 image with the types
function gameOf(types: GameType[]): Game {
    const images = [{ name: 'Big.dll', firstType: 0, typeCount: types.length }];

    return {
        fileVersion: 31,
        layout: '31.1',
        isLayoutGuessed: false,
        unityVersion: '2022.3.33f1',
        pointerSize: 8,
        images,
        types,
        strings: [],
        globals: [],
    };
}

// lists the fixture's metadata alone with the path of each row, like `Assembly-CSharp.dll/Shapes/Circle/Area()`
async function listMetadata() {
    const engine = connect();
    const metadata = await readFixture('global-metadata.dat');
    const listing = await engine.list(await engine.open(metadata.name, metadata));
    const rows = readRows(listing);
    const paths: string[] = [];
    for (const { name, parent } of rows) {
        paths.push(parent < 0 ? name : `${paths[parent]}/${name}`);
    }

    return { listing, rows, paths };
}

function describeRow(row: Row, path: string): string {
    const flags = [accessibilityOf(row.flags), ...modifiersOf(row.flags)].filter(word => word !== '');

    return [row.kind, path, ...flags].join(' ');
}

test("il2cpp engine lists the metadata's images, namespaces, types and members by name", async () => {
    const { rows, paths } = await listMetadata();
    const game = [...rows.keys()].filter(index => paths[index].startsWith('Assembly-CSharp.dll'));

    expect(paths.filter(path => !path.includes('/'))).toEqual(['mscorlib.dll', 'Assembly-CSharp.dll']);
    expect(game.map(index => describeRow(rows[index], paths[index]))).toEqual([
        'section Assembly-CSharp.dll',
        'class Assembly-CSharp.dll/Player public document',
        'method Assembly-CSharp.dll/Player/Start() public',
        'method Assembly-CSharp.dll/Player/Update() public',
        'namespace Assembly-CSharp.dll/Shapes',
        'class Assembly-CSharp.dll/Shapes/Circle public document',
        'field Assembly-CSharp.dll/Shapes/Circle/radius',
        'field Assembly-CSharp.dll/Shapes/Circle/count',
        'constructor Assembly-CSharp.dll/Shapes/Circle/Circle(radius) public',
        'method Assembly-CSharp.dll/Shapes/Circle/Area() public override',
        'method Assembly-CSharp.dll/Shapes/Circle/Draw() public virtual',
        'method Assembly-CSharp.dll/Shapes/Circle/Unit() public static',
        'method Assembly-CSharp.dll/Shapes/Circle/Scale(factors) public',
        'property Assembly-CSharp.dll/Shapes/Circle/Radius public',
        'method Assembly-CSharp.dll/Shapes/Circle/Radius/get_Radius() public',
        'method Assembly-CSharp.dll/Shapes/Circle/Radius/set_Radius(value) public',
        'class Assembly-CSharp.dll/Shapes/Circle/Builder public document',
        'method Assembly-CSharp.dll/Shapes/Circle/Builder/Build() public',
        'enum Assembly-CSharp.dll/Shapes/Color public document',
        'enum_member Assembly-CSharp.dll/Shapes/Color/Red',
        'enum_member Assembly-CSharp.dll/Shapes/Color/Green',
        'enum_member Assembly-CSharp.dll/Shapes/Color/Blue',
        'interface Assembly-CSharp.dll/Shapes/IDrawable public document',
        'method Assembly-CSharp.dll/Shapes/IDrawable/Draw() public abstract',
        'struct Assembly-CSharp.dll/Shapes/Point public document',
        'field Assembly-CSharp.dll/Shapes/Point/x',
        'field Assembly-CSharp.dll/Shapes/Point/y',
        'method Assembly-CSharp.dll/Shapes/Point/Length() public',
        'class Assembly-CSharp.dll/Shapes/Shape public document abstract',
        'field Assembly-CSharp.dll/Shapes/Shape/name',
        'constructor Assembly-CSharp.dll/Shapes/Shape/Shape(name) public',
        'method Assembly-CSharp.dll/Shapes/Shape/Area() public abstract',
        'method Assembly-CSharp.dll/Shapes/Shape/Describe() public virtual',
    ]);
});

test("il2cpp engine asks for the game's binary as a companion of the metadata and says the listing has names only", async () => {
    const { listing } = await listMetadata();

    expect(listing.missingFiles).toEqual([
        { name: 'GameAssembly.dll', otherNames: ['libil2cpp.so'], reason: 'not loaded, or libil2cpp.so on Android and Linux', isCompanion: true },
    ]);
    expect(listing.note).toBe('names only');
});

test('il2cpp engine gives every row of the metadata its own key', async () => {
    const { rows } = await listMetadata();

    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
});

test("indexCodeMethods leaves out the methods whose code another method shares, so the C's call of that code stays C", () => {
    const method = (name: string, rva: number) => ({ name, flags: 0, returnType: null, parameters: [], genericParameters: [], rva });
    const type = (name: string, methods: GameMethod[]): GameType => ({
        namespace: 'N',
        name,
        declaringType: -1,
        flags: 1,
        isValueType: false,
        isEnum: false,
        genericParameters: [],
        baseType: null,
        fields: [],
        methods,
        properties: [],
    });
    const types = [type('A`1', [method('Start', 0x1000), method('Run', 0x2000)]), type('B', [method('Awake', 0x1000)])];
    const game = gameOf(types);

    const methods = indexCodeMethods(game, countMemberStarts(game), rva => rva);

    expect(methods.get(0x1000)).toBeNull();
    expect(methods.get(0x2000)).toEqual({ key: firstKeys.method + 1, typeIndex: 0 });
});
