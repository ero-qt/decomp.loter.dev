import { expect, test } from 'bun:test';
import { readBuildFile, realBuilds } from './real-builds';
import { openNativeGame, readCodeGame, readFixture } from './testing';

const build = realBuilds['2019.4.34'];

test("native engine decompiles a real game's method under its C# name and reads its fields through the class's struct", async () => {
    const game = await openNativeGame(await readBuildFile(build.metadata), await readBuildFile(build.binary));
    // `ArrayList.get_Item` checks the index against `_size` at 0x18, then reads `_items` at 0x10
    const text = await game.readMethod('ArrayList', 'get_Item');
    await game.close();

    expect(text).toContain('System.Collections.ArrayList$$get_Item(');
    expect(text).toContain('ArrayList_o *__this');
    expect(text).toContain('__this->_size');
    expect(text).toContain('__this->_items');
}, 300000);

test("native engine reads a real game's static fields through the class's TypeInfo global and its struct", async () => {
    const game = await openNativeGame(await readBuildFile(build.metadata), await readBuildFile(build.binary));
    // `Debug.get_unityLogger` runs the class's static constructor first, then returns the static field `s_Logger`
    const text = await game.readMethod('Debug', 'get_unityLogger');
    await game.close();

    expect(text).toContain('UnityEngine.Debug_TypeInfo->cctor_finished');
    expect(text).toContain('UnityEngine.Debug_TypeInfo->static_fields->s_Logger');
    expect(text).not.toContain('+ 0xe0)');
    expect(text).not.toContain('+ 0xb8)');
}, 300000);

test("native engine reads the static fields of a version 31 game through the TypeInfo globals that LibCpp2IL finds", async () => {
    const newer = realBuilds['2022.3.35'];
    const game = await openNativeGame(await readBuildFile(newer.metadata), await readBuildFile(newer.binary));
    const text = await game.readMethod('Debug', 'get_unityLogger');
    await game.close();

    expect(text).toContain('_TypeInfo->static_fields->');
    expect(text).not.toContain('+ 0xe0)');
    expect(text).not.toContain('+ 0xb8)');
}, 300000);

test("native engine decompiles the Thumb code of an armv7 libil2cpp.so under the method's C# name", async () => {
    const armv7 = new File([await (await readFixture('libil2cpp-armv7.so')).bytes()], 'libil2cpp.so');
    const game = await openNativeGame(await readFixture('global-metadata.dat'), armv7);
    const text = await game.readMethod('Player', 'Update');
    await game.close();

    // `Player.Update` calls `Shapes.Circle.Area` and adds a constant to the result
    expect(text).toContain('Player$$Update(');
    expect(text).toContain('Shapes.Circle$$Area(');
}, 300000);

test("native engine reads a method with its signature after it decompiled a caller of the method", async () => {
    const game = await openNativeGame(await readCodeGame('global-metadata.dat'), await readCodeGame('GameAssembly.dll'));
    await game.readMethod('Circle', 'Grow');
    const text = await game.readMethod('Circle', 'set_Radius');
    await game.close();

    expect(text).toContain('Shapes.Circle$$set_Radius(Circle_o *__this, int32_t value, void *method)');
}, 300000);
