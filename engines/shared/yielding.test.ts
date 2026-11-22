import { expect, test } from 'bun:test';
import { createYielder } from './yielding';

test('a loop with the yielder throws within 100 ms of the abort', async () => {
    const controller = new AbortController();
    const yieldTurn = createYielder(controller.signal);
    let abortedAt = 0;
    setTimeout(() => {
        abortedAt = performance.now();
        controller.abort();
    }, 20);

    const loop = async () => {
        while (true) {
            await yieldTurn();
        }
    };

    await expect(loop()).rejects.toThrow('aborted');
    expect(performance.now() - abortedAt).toBeLessThan(100);
});

test('the yielder throws at once for a signal that aborted', async () => {
    await expect(createYielder(AbortSignal.abort())()).rejects.toThrow('aborted');
});
