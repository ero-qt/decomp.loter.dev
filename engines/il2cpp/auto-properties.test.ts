import { findRow } from '#contract/checking';
import { afterAll, expect, test } from 'bun:test';
import { mountInMemory } from '../native/files';
import { createNativeHandlers } from '../native/handlers';
import { loadTestModule } from '../native/testing';
import { cutMember, loadTestRuntime, openCodeGame } from './testing';

await Promise.all([loadTestRuntime(), loadTestModule()]);

// the addresses of the code that the native engine decompiled
const decompiled: number[] = [];

const game = await openCodeGame('GameAssembly.dll', () => {
    const native = createNativeHandlers(loadTestModule, mountInMemory);
    const { readCode } = native;
    native.readCode = (fileId, rva, ...rest) => {
        decompiled.push(rva);

        return readCode(fileId, rva, ...rest);
    };

    return native;
});

afterAll(() => game.close());

test("a property with the compiler's backing field stays an auto-property, and its setter isn't decompiled", async () => {
    const circle = (await game.readType('Shapes.Circle')).text;
    const setter = findRow(game.rows, 'Assembly-CSharp.dll.Shapes.Circle.Radius.set_Radius(int)', 'global-metadata.dat');

    expect(circle).toContain('\tpublic int Radius { get; set; }\n');
    expect(decompiled).not.toContain(Number(setter.detail));
}, 120000);

test('a property without a backing field has the body of its getter', async () => {
    const circle = (await game.readType('Shapes.Circle')).text;

    expect(cutMember(circle, 'public bool IsUnit')).toContain('\t\tget\n\t\t{\n\t\t\tint iVar1;\n');
}, 120000);
