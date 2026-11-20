import { expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture, pickNewestVersion } from './fixture/build';

const fixtureFolder = fileURLToPath(new URL('../../artifacts/dotnet-fixture/', import.meta.url));
const dotnet = Bun.which('dotnet') ?? undefined;

await buildFixture(fixtureFolder, dotnet);

test("fixture's assemblies stay under 20,000 bytes together", () => {
    const sizes = ['Shapes.dll', 'Drawing.dll'].map(name => statSync(join(fixtureFolder, name)).size);

    expect(sizes[0] + sizes[1]).toBeLessThan(20000);
});

test('buildFixture writes the same bytes on every build', async () => {
    const again = fileURLToPath(new URL('../../artifacts/dotnet-fixture-again/', import.meta.url));
    rmSync(again, { recursive: true, force: true });

    await buildFixture(again, dotnet);

    for (const name of ['Shapes.dll', 'Drawing.dll']) {
        expect(await Bun.file(join(again, name)).bytes()).toEqual(await Bun.file(join(fixtureFolder, name)).bytes());
    }
    rmSync(again, { recursive: true, force: true });
});

test("buildFixture rebuilds assemblies whose stamp doesn't match the sources, the build's script, the SDK or the reference pack", async () => {
    const again = fileURLToPath(new URL('../../artifacts/dotnet-fixture-stamp/', import.meta.url));
    const stamp = join(again, 'fixture.stamp');
    rmSync(again, { recursive: true, force: true });
    await buildFixture(again, dotnet);
    const built = readFileSync(stamp, 'utf8');
    const [sources, sdk, references] = built.split('\n');

    expect(references).toMatch(/^11\.0\.\d+/);

    writeFileSync(stamp, `changed\n${sdk}\n${references}`);
    await expect(buildFixture(again, undefined)).rejects.toThrow('Install the .NET SDK');

    for (const stale of [`${sources}\nan older SDK\n${references}`, `${sources}\n${sdk}\nan older reference pack`]) {
        writeFileSync(stamp, stale);
        await buildFixture(again, dotnet);
        expect(readFileSync(stamp, 'utf8')).toBe(built);
    }
    rmSync(again, { recursive: true, force: true });
}, 60000);

test('pickNewestVersion orders versions like semantic versions, with a release after its previews', () => {
    expect(pickNewestVersion(['11.0.0-rc.3.26522.148', '11.0.0', '11.0.0-rc.10.1', '9.0.10', '9.0.9'])).toBe('11.0.0');
    expect(pickNewestVersion(['11.0.0-rc.3.26522.148', '11.0.0-rc.10.1', '9.0.10'])).toBe('11.0.0-rc.10.1');
    expect(pickNewestVersion(['9.0.9', '9.0.10'])).toBe('9.0.10');
});

test('buildFixture keeps assemblies whose stamp matches the sources without an SDK', async () => {
    await buildFixture(fixtureFolder, undefined);
});

test('buildFixture asks for the SDK when it has to build without one', async () => {
    const missing = fileURLToPath(new URL('../../artifacts/dotnet-fixture-missing/', import.meta.url));
    rmSync(missing, { recursive: true, force: true });

    await expect(buildFixture(missing, undefined)).rejects.toThrow('Install the .NET SDK 11 because the tests build the .NET fixture with it.');
});
