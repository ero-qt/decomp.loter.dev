import { expect, test } from 'bun:test';
import { EngineError, failed, ok, unwrap } from './reply';

test('unwrap returns the value of a reply, also a null', () => {
    expect(unwrap(ok(3))).toBe(3);
    expect(unwrap(ok(null))).toBeNull();
});

test('unwrap throws the error text of a failed reply as an engine error', () => {
    expect(() => unwrap(failed("a.dll isn't an assembly"))).toThrow(new EngineError("a.dll isn't an assembly"));
});
