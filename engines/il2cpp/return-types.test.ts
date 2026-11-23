import { afterAll, expect, test } from 'bun:test';
import { loadTestModule } from '../native/testing';
import { cutMember, loadTestRuntime, openCodeGame } from './testing';

await Promise.all([loadTestRuntime(), loadTestModule()]);

const game = await openCodeGame();

afterAll(() => game.close());

test('a method returns the value of a call when its return type is not void', async () => {
    const same = cutMember((await game.readType('Shapes.Circle')).text, 'public bool Same(Circle other)');

    expect(same).toContain('return ');
    expect(same).not.toContain('return;');
}, 120000);
