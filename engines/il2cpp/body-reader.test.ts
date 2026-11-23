import { writeTokens } from '#contract/document';
import type { EmbeddedLines } from '#contract/embedding';
import { failed, ok } from '#contract/reply';
import { expect, test } from 'bun:test';
import type { NativeHandlers } from '../native/handlers';
import { type BodyReader, createBodyReader } from './bodies';

const game = {
    binaryName: 'GameAssembly.dll',
    binary: new Blob(),
    writeNames: () => ({ lines: new Blob(), writeTypes: () => ({ header: '', globals: '' }) }),
    link: (lines: EmbeddedLines) => lines,
};

// creates native handlers whose C at each address has a body of 100 characters, and notes each decompiled address
function createFakeNative(rvas: number[]): NativeHandlers {
    const native: Partial<NativeHandlers> = {
        open: () => ok(undefined),
        loadNames: async () => ok(undefined),
        listCodeTargets: async () => ok([]),
        async readCode(_, rva) {
            rvas.push(rva);

            return ok(writeTokens(`void f(void)\n{\n${'x'.repeat(100)}\n}\n`, [], []));
        },
        close: () => ok(undefined),
    };

    return native as NativeHandlers;
}

// reads the bodies at the addresses until no read leaves any out
async function readWhole(reader: BodyReader, rvas: number[]) {
    for (;;) {
        const read = await reader.readBodies(1, game, rvas, new AbortController().signal);
        if (!read.isPartial) {
            return read;
        }
    }
}

test('the body reader drops the bodies read longest ago once their text passes its size, and decompiles them again', async () => {
    const rvas: number[] = [];
    const reader = createBodyReader(() => createFakeNative(rvas), 250);
    const signal = new AbortController().signal;

    await readWhole(reader, [0x10, 0x20, 0x30]);
    await readWhole(reader, [0x30, 0x10]);

    expect(rvas).toEqual([0x10, 0x20, 0x30, 0x10]);
});

test("a body that the native engine refuses says why in a comment, so it doesn't read like an empty method", async () => {
    const native = { ...createFakeNative([]), readCode: async () => failed("Rizin doesn't find a function at 0x10.") };
    const reader = createBodyReader(() => native);

    const { bodies } = await readWhole(reader, [0x10]);

    expect(bodies.get(0x10)?.text).toBe("    // Rizin doesn't find a function at 0x10.");
});

test("each body of a binary that the native engine refuses says why in a comment", async () => {
    const native = { ...createFakeNative([]), open: () => failed("GameAssembly.dll isn't a readable ELF, PE or Mach-O file.") };
    const reader = createBodyReader(() => native);

    const { bodies } = await readWhole(reader, [0x10, 0x20]);

    expect([...bodies.values()].map(body => body?.text)).toEqual(Array(2).fill("    // GameAssembly.dll isn't a readable ELF, PE or Mach-O file."));
});

test("a file's close while the native engine still opens its binary closes the binary once it opened, before it opens again", async () => {
    const calls: string[] = [];
    const opening = Promise.withResolvers<void>();
    const native = {
        ...createFakeNative([]),
        async open() {
            calls.push('open');
            await opening.promise;
            calls.push('opened');

            return ok(undefined);
        },
        close() {
            calls.push('close');

            return ok(undefined);
        },
    };
    const reader = createBodyReader(() => native);
    const signal = new AbortController().signal;

    const first = reader.readBodies(1, game, [0x10], signal).catch(() => undefined);
    await Bun.sleep(10);
    reader.close(1);
    const second = readWhole(reader, [0x10]);
    await Bun.sleep(10);
    opening.resolve();
    await Promise.all([first, second]);

    expect(calls).toEqual(['open', 'opened', 'close', 'open', 'opened']);
});

test('the body reader links each body once, and a later read takes the linked body', async () => {
    let links = 0;
    const counted = { ...game, link: (lines: EmbeddedLines) => (links++, { ...lines, text: 'linked' }) };
    const reader = createBodyReader(() => createFakeNative([]));
    const signal = new AbortController().signal;

    await reader.readBodies(1, counted, [0x10], signal);
    await readWhole(reader, [0x10]);
    const { bodies } = await reader.readBodies(1, counted, [0x10], signal);

    expect(links).toBe(1);
    expect(bodies.get(0x10)?.text).toBe('linked');
});

test("a read before the binary opened replies at once with the bodies left out, because the open blocks the worker", async () => {
    const events: string[] = [];
    const native = {
        ...createFakeNative([]),
        async open() {
            await Bun.sleep(300);
            events.push('opened');

            return ok(undefined);
        },
    };
    const reader = createBodyReader(() => native);

    const { isPartial } = await reader.readBodies(1, game, [0x10], new AbortController().signal);
    events.push('read');
    await readWhole(reader, [0x10]);

    expect(isPartial).toBe(true);
    expect(events).toEqual(['read', 'opened']);
});
