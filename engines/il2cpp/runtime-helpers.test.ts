import { afterAll, expect, test } from 'bun:test';
import { openNativeGame, readCodeGame } from './testing';

const game = await openNativeGame(await readCodeGame('global-metadata.dat'), await readCodeGame('GameAssembly.dll'));

afterAll(() => game.close());

test("a method's path ends at the call of a helper that raises an exception, which has the helper's name", async () => {
    const grow = await game.readMethod('Circle', 'Grow');

    expect(grow).toContain('il2cpp_codegen_raise_null_reference_exception();');
    expect(grow).not.toContain('Describe');
}, 120000);

test("the runtime's helpers have their names where a method allocates an object and stores a reference", async () => {
    const unit = await game.readMethod('Circle', 'Unit');

    expect(unit).toContain(' = il2cpp_codegen_object_new(Shapes.Circle_TypeInfo);');
    expect(unit).toContain('il2cpp_codegen_runtime_class_init(Shapes.Circle_TypeInfo);');
    expect(unit).toContain('Il2CppCodeGenWriteBarrier(');
}, 120000);

test('the function that takes the address of a metadata global has the name of the helper that fills the global', async () => {
    const unit = await game.readMethod('Circle', 'Unit');

    expect(unit).toContain('il2cpp_codegen_initialize_runtime_metadata(&Shapes.Circle_TypeInfo);');
    expect(unit).not.toContain('sub_');
}, 120000);

test("a method after a method that ends in a helper's call without a return still has its code", async () => {
    await game.readMethod('Circle', 'Grow');

    // `Circle.Describe` only jumps to the base class's method, right after the helper's call at the end of `Grow`
    expect(await game.readMethod('Circle', 'Describe')).toContain('Shapes.Shape$$Describe(');
}, 120000);
