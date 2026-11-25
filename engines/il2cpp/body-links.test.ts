import { formatTarget } from '#contract/document';
import { expect, test } from 'bun:test';
import { createBodyLinker } from './body-links';
import { countMemberStarts, firstKeys, listRows } from './rows';
import { loadTestRuntime, readFixture, readGame } from './testing';

const runtime = await loadTestRuntime();

test("a property without a setter doesn't take the link of the accessor before its type's methods", async () => {
    const game = readGame(runtime, await (await readFixture('global-metadata.dat')).bytes(), await (await readFixture('GameAssembly.dll')).bytes());
    const circleIndex = game.types.findIndex(type => type.name === 'Circle');
    const circle = game.types[circleIndex];
    // makes Circle's last method the setter of its property, before the methods of the next type, which gets a
    // property with only a getter
    const last = circle.methods.length - 1;
    circle.properties[0].setter = last;
    game.types[circleIndex + 1].properties.push({ name: 'Only', getter: 0, setter: -1 });
    const starts = countMemberStarts(game);
    const linker = createBodyLinker(1, { game, starts, rowsByKey: new Map(listRows(game).map(row => [row.key, row])) }, rva => rva);
    const accessor = formatTarget({ outside: `#property:${circle.methods[last].rva!.toString(16)}` });

    const { tokens } = linker.link({ text: 'Radius', tokens: [{ start: 0, length: 6, kind: 'property', flags: 0, target: accessor }], locals: [] });

    expect(tokens[0].target).toBe(formatTarget({ fileId: 1, key: firstKeys.property + starts.properties[circleIndex] }));
});
