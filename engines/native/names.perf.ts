import { expect, test } from 'bun:test';
import { mountInMemory } from './files';
import { symbolCounts } from './fixture/build';
import { loadTestModule, readFixture } from './testing';

const module = await loadTestModule();

test(`a function with ${symbolCounts.calls} calls in a file of ${symbolCounts.functions} functions prepares in less than 1.5 s`, async () => {
    const mounted = await mountInMemory(module.fs, '/files/names-perf', 'binary', await readFixture('symbols.so'));
    const session = module.newSession();
    module.openSession(session, mounted.path);
    const caller = module.listSymbols(session, 5).functions.find(found => found.name === 'caller')!;

    const start = performance.now();
    const prepared = module.prepareFunction(session, BigInt(caller.addr));
    const elapsedMs = performance.now() - start;
    module.freeSession(session);
    mounted.unmount();

    expect(prepared?.name).toBe('caller');
    expect(elapsedMs).toBeLessThan(1500);
}, 120000);
