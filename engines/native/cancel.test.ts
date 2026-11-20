import { expect, test } from 'bun:test';
import { readRows } from '../../contract/rows';
import { mountInMemory } from './files';
import { createNativeHandlers } from './handlers';
import type { NativeModule } from './module';
import { loadTestModule, readFixture } from './testing';

const module = await loadTestModule();

// opens shapes-x64.so in new handlers whose module aborts the controller during each decompile, and returns the key
// of Rect, whose document decompiles 2 methods
async function openWatched(controller: { current: AbortController }) {
    const counts = { decompiles: 0 };
    const watched: NativeModule = {
        ...module,
        decompile(session, address) {
            counts.decompiles++;
            controller.current.abort();

            return module.decompile(session, address);
        },
    };
    const handlers = createNativeHandlers(async () => watched, mountInMemory);
    const file = await readFixture('shapes-x64.so');
    const signal = new AbortController().signal;
    await handlers.open(1, file.name, file, signal);
    const listing = await handlers.list(1, signal);
    const rect = readRows(listing.value!).find(row => row.name === 'Rect')!;

    return { handlers, counts, key: rect.key };
}

test('a read stops between two methods after a cancel', async () => {
    const controller = { current: new AbortController() };
    const { handlers, counts, key } = await openWatched(controller);

    await expect(handlers.read(1, key, 'c', controller.current.signal)).rejects.toThrow();
    expect(counts.decompiles).toBe(1);
}, 120000);

test('a second read after a canceled read returns the same text', async () => {
    const controller = { current: new AbortController() };
    const { handlers, counts, key } = await openWatched(controller);
    const fresh = await openWatched({ current: new AbortController() });

    await expect(handlers.read(1, key, 'c', controller.current.signal)).rejects.toThrow();
    controller.current = new AbortController();
    const second = await handlers.read(1, key, 'c', new AbortController().signal);

    expect(second.value?.text).toBe((await fresh.handlers.read(1, fresh.key, 'c', new AbortController().signal)).value?.text);
    expect(counts.decompiles).toBe(2);
}, 120000);
