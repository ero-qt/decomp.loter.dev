import { expect, test } from 'bun:test';
import { compileAssembly, loadTestRuntime, useDotnetEngine } from './testing';

const connect = useDotnetEngine();
await loadTestRuntime();

const typeCount = 2000;

function writeTypes(): string {
    const types = Array.from({ length: typeCount }, (_, index) => {
        return `public class Type${index} { public int field; public int Value { get; set; } public int Add(int value) => value + ${index}; }`;
    });

    return types.join('\n');
}

test(`a file of ${typeCount} types lists at once again after another file that it doesn't reference opens and closes`, async () => {
    const engine = connect();
    const large = await compileAssembly('LargeOpen', writeTypes());
    const other = await compileAssembly('OtherOpen', 'public class Other { }');
    const fileId = await engine.open(large.name, large);

    const firstStart = performance.now();
    await engine.list(fileId);
    const firstMs = performance.now() - firstStart;

    const otherId = await engine.open(other.name, other);
    const openedStart = performance.now();
    await engine.list(fileId);
    const openedMs = performance.now() - openedStart;

    await engine.close(otherId);
    const closedStart = performance.now();
    await engine.list(fileId);
    const closedMs = performance.now() - closedStart;

    expect(openedMs).toBeLessThan(firstMs / 4);
    expect(closedMs).toBeLessThan(firstMs / 4);
}, 120000);
