import { expect, test } from 'bun:test';
import { mountInMemory } from './files';
import { createNativeHandlers } from './handlers';
import { loadTestModule, readFixture } from './testing';

const module = await loadTestModule();
const signal = new AbortController().signal;

test('native engine opens a dll with 262,144 base relocations in less than 48 MB of wasm memory beside the file', async () => {
    const handlers = createNativeHandlers(loadTestModule, mountInMemory);
    const dll = await readFixture('relocations.dll');
    await handlers.open(1, 'shapes.dll', await readFixture('shapes.dll'), signal);
    const before = module.readMemoryBytes();

    const opened = await handlers.open(2, dll.name, dll, signal);

    expect(opened.error).toBeUndefined();
    expect(module.readMemoryBytes() - before - dll.size).toBeLessThan(48 * 1024 * 1024);
}, 120000);
