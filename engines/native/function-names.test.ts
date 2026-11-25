import { afterAll, expect, test } from 'bun:test';
import { mountInMemory } from './files';
import { loadTestModule, readFixture } from './testing';

const module = await loadTestModule();
const mounted = await mountInMemory(module.fs, '/files/function-names', 'binary', await readFixture('symbols.so'));
const session = module.newSession();
module.openSession(session, mounted.path);
// lists the 5 functions with the lowest addresses, which are `caller`, the 2 functions with special names and 2 others
const functions = module.listSymbols(session, 5).functions;

afterAll(() => {
    module.freeSession(session);
    mounted.unmount();
});

function prepareNamed(name: string) {
    return module.prepareFunction(session, BigInt(functions.find(found => found.name === name)!.addr));
}

test("code keeps the name of a Go method, whose parentheses aren't its parameters", () => {
    expect(prepareNamed('main.(*T).Method')?.name).toBe('main.(*T).Method');
});

test('code keeps the name of a function in an anonymous namespace without parameters', () => {
    expect(prepareNamed('(anonymous namespace)::x')?.name).toBe('(anonymous namespace)::x');
});
