import { expect, test } from 'bun:test';
import { failed, ok } from '../../contract/reply';
import { mountInMemory } from './files';
import { createNativeHandlers } from './handlers';
import { ModuleError } from './module';
import { loadTestModule, readFixture, useNativeEngine } from './testing';

const connect = useNativeEngine();
await loadTestModule();

test('native engine opens elf, pe and thin and fat mach-o files and closes them', async () => {
    const engine = connect();
    const names = ['shapes-x64.so', 'shapes-a64.so', 'shapes-x86.so', 'shapes.dll', 'shapes-x86.dll', 'shapes-arm64.dylib', 'shapes-fat.dylib'];

    for (const name of names) {
        const file = await readFixture(name);

        await engine.close(await engine.open(file.name, file));
    }
}, 120000);

test('native engine refuses a file that only starts like an elf', async () => {
    const engine = connect();
    const broken = new File([`\x7fELF${'not an elf file, '.repeat(4)}`], 'broken.so');

    await expect(engine.open(broken.name, broken)).rejects.toThrow("broken.so isn't a readable ELF, PE or Mach-O file.");
});

test('native engine refuses a pe that only imports mscoree.dll', async () => {
    const engine = connect();
    const stub = await readFixture('managed-stub.exe');

    const refusal = 'managed-stub.exe only imports mscoree.dll, so its code is .NET IL and not machine code.';

    await expect(engine.open(stub.name, stub)).rejects.toThrow(refusal);
}, 120000);

test('native engine refuses calls for a closed file', async () => {
    const handlers = createNativeHandlers(loadTestModule, mountInMemory);
    const signal = new AbortController().signal;
    const file = await readFixture('shapes-x64.so');
    const refusal = failed("The native engine doesn't have an open file with the id 1.");

    expect(await handlers.open(1, file.name, file, signal)).toEqual(ok(undefined));
    expect(await handlers.close(1, signal)).toEqual(ok(undefined));
    expect(await handlers.close(1, signal)).toEqual(refusal);
    expect(await handlers.list(1, signal)).toEqual(refusal);
    expect(await handlers.read(1, 0, 'c', signal)).toEqual(refusal);
    expect(await handlers.listStrings(1, signal)).toEqual(refusal);
    expect(await handlers.provide(1, 'shapes.pdb', file, signal)).toEqual(refusal);
}, 120000);

test('a failed load of the module becomes a failed reply, and the next call loads it again', async () => {
    const module = await loadTestModule();
    const refusal = "The native engine couldn't load rizin.mjs: 404 Not Found";
    let loads = 0;
    const handlers = createNativeHandlers(async () => {
        loads++;
        if (loads === 1) {
            throw new ModuleError(refusal);
        }

        return module;
    }, mountInMemory);
    const file = await readFixture('shapes-x64.so');
    const signal = new AbortController().signal;

    expect(await handlers.open(1, file.name, file, signal)).toEqual(failed(refusal));
    expect(await handlers.open(1, file.name, file, signal)).toEqual(ok(undefined));
}, 120000);
