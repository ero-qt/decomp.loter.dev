import { findRow } from '#contract/checking';
import { formatTarget } from '#contract/document';
import { unwrap } from '#contract/reply';
import { readRows } from '#contract/rows';
import type { EngineHandlers } from '#contract/serve';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { createDotnetHandlers } from './handlers';
import type { DotnetExports, DotnetRuntime } from './runtime';
import { compileAssembly, loadTestRuntime } from './testing';

await loadTestRuntime();
setDefaultTimeout(120000);

const classCount = 200;
const methodCount = 30;
const stringCount = 5;
const callCount = 8;
// the time between the engine's checks, which a call has to pass before it sees a cancel
const checkIntervalMs = 50;

// writes classes whose methods each read 1 field and load their own strings, so a search for the field's users, a
// listing of the strings and a listing of the rows each take several times the time between the engine's checks, even
// on a fast machine. Loads the strings in a lambda because the engine then looks up the method around the lambda for
// each string, which keeps the listing of the strings long below the engine's cap on strings. Calls a generic method
// with type arguments that no other method uses before the field's read, because the search resolves each token
// only once per file and then has to resolve each of these calls.
function writeManyMethods(): string {
    const strings = (index: number, method: number) => Array.from({ length: stringCount }, (_, string) => `"s${index}_${method}_${string}"`);
    const calls = (index: number, method: number) => Array.from({ length: callCount }, (_, call) => `Target.Use<C${index}, C${method}, C${call}>();`);
    const writeMethod = (index: number, method: number) =>
        `public int M${method}() { System.Func<string> load = () => string.Concat(${strings(index, method).join(', ')}); `
        + `System.Console.WriteLine(load()); ${calls(index, method).join(' ')} return Target.Value; }`;
    const methods = (index: number) => Array.from({ length: methodCount }, (_, method) => writeMethod(index, method));
    const classes = Array.from({ length: classCount }, (_, index) => `public class C${index} { ${methods(index).join(' ')} }`);

    return `public static class Target { public static int Value; public static void Use<A, B, C>() { } } ${classes.join(' ')}`;
}

interface CancelingHandlers {
    handlers: EngineHandlers;
    /** Runs a call with a signal that aborts once the C# call has started. */
    cancel<T>(call: (signal: AbortSignal) => T | Promise<T>): Promise<T>;
}

// serves handlers whose exports abort the armed signal on a timer once a call starts, which fires at the call's first
// wait, so the C# call has started and sees the cancel at its next check
function createCancelingHandlers(): CancelingHandlers {
    let armed: AbortController | undefined;

    function abortOnCall(target: DotnetExports, name: keyof DotnetExports) {
        const value = target[name];
        if (typeof value !== 'function' || name === 'Cancel' || name === 'Reset') {
            return value;
        }

        return (...args: unknown[]) => {
            const controller = armed;
            armed = undefined;
            if (controller) {
                setTimeout(() => controller.abort());
            }

            return (value as (...values: unknown[]) => unknown).apply(target, args);
        };
    }

    async function loadRuntime(): Promise<DotnetRuntime> {
        const runtime = await loadTestRuntime();

        return { ...runtime, exports: new Proxy(runtime.exports, { get: abortOnCall }) };
    }

    return {
        handlers: createDotnetHandlers(loadRuntime),
        async cancel(call) {
            armed = new AbortController();

            return call(armed.signal);
        },
    };
}

const running = () => new AbortController().signal;

// runs a call that isn't canceled and checks that it takes several times the time between the engine's checks, because
// a call that ends before its first check can't see a cancel
async function timeCall<T>(call: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await call();

    expect(performance.now() - start).toBeGreaterThan(checkIntervalMs * 4);

    return result;
}

test('dotnet engine stops a search for users and a listing of strings once its signal aborts', async () => {
    const { handlers, cancel } = createCancelingHandlers();
    const assembly = await compileAssembly('Many', writeManyMethods());
    unwrap(await handlers.open(1, assembly.name, assembly, running()));
    const rows = readRows(unwrap(await handlers.list(1, running())));
    const value = formatTarget({ fileId: 1, key: findRow(rows, 'Target.Value', assembly.name).key });

    expect(unwrap(await timeCall(() => handlers.findReferences(value, 'csharp', running())))).toHaveLength(classCount * methodCount);
    expect(unwrap(await timeCall(() => handlers.listStrings(1, running())))).toHaveLength(classCount * methodCount * stringCount);
    await expect(cancel(signal => handlers.findReferences(value, 'csharp', signal))).rejects.toThrow('aborted');
    await expect(cancel(signal => handlers.listStrings(1, signal))).rejects.toThrow('aborted');
});

test('a read that the engine cancels while it lists the rows leaves the next read the same as a fresh one', async () => {
    const { handlers, cancel } = createCancelingHandlers();
    const assembly = await compileAssembly('Many', writeManyMethods());
    unwrap(await handlers.open(1, assembly.name, assembly, running()));
    const target = findRow(readRows(unwrap(await handlers.list(1, running()))), 'Target', assembly.name).key;

    // opens the file again before each read because a file that just opened doesn't have rows, which the read then lists
    async function reopen() {
        unwrap(await handlers.close(1, running()));
        unwrap(await handlers.open(1, assembly.name, assembly, running()));
    }

    await reopen();
    const fresh = unwrap(await timeCall(() => handlers.read(1, target, 'csharp', running())));
    await reopen();

    await expect(cancel(signal => handlers.read(1, target, 'csharp', signal))).rejects.toThrow('aborted');
    expect(unwrap(await handlers.read(1, target, 'csharp', running()))).toEqual(fresh);
});
