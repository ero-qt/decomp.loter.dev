import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, fixtureFolder } from './fixture';
import { buildFixture } from './fixture/build';
import { openZip } from './zip';

// gives each test that runs javac a minute because javac takes several seconds on a busy machine
const javacTimeoutMs = 60000;

test("fixture's JARs stay under 20,000 bytes together", () => {
    expect(fixture.file.size + fixture.linked.file.size).toBeLessThan(20000);
});

test("fixture's JARs have a class for each source file", async () => {
    const sources = readdirSync(new URL('fixture/src/', import.meta.url), { recursive: true, encoding: 'utf8' })
        .filter(path => path.endsWith('.java'));
    const jars = await Promise.all([fixture.file, fixture.linked.file].map(async file => openZip(await file.bytes())));
    const entries = new Set(jars.flatMap(jar => jar.names));

    expect(sources.filter(path => !entries.has(path.replace(/\.java$/, '.class')))).toEqual([]);
    expect(sources).toHaveLength(10);
});

test('buildFixture writes the same bytes on every build', async () => {
    const again = fileURLToPath(new URL('../../artifacts/java-fixture-again/', import.meta.url));
    rmSync(again, { recursive: true, force: true });

    await buildFixture(again, process.env.JAVA_HOME);

    expect(await Bun.file(join(again, 'drawing.jar')).bytes()).toEqual(await fixture.file.bytes());
    expect(await Bun.file(join(again, 'shapes.jar')).bytes()).toEqual(await fixture.linked.file.bytes());
    rmSync(again, { recursive: true, force: true });
}, javacTimeoutMs);

test("buildFixture rebuilds JARs whose stamp doesn't match the sources, the build's scripts or the JDK", async () => {
    const again = fileURLToPath(new URL('../../artifacts/java-fixture-stamp/', import.meta.url));
    const stamp = join(again, 'build.stamp');
    rmSync(again, { recursive: true, force: true });
    await buildFixture(again, process.env.JAVA_HOME);
    const [sources, jdk] = readFileSync(stamp, 'utf8').split('\n');

    writeFileSync(stamp, `changed\n${jdk}`);
    await expect(buildFixture(again, undefined)).rejects.toThrow('Set JAVA_HOME');

    writeFileSync(stamp, `${sources}\nan older JDK`);
    await buildFixture(again, process.env.JAVA_HOME);
    expect(readFileSync(stamp, 'utf8')).toBe(`${sources}\n${jdk}`);
    rmSync(again, { recursive: true, force: true });
}, javacTimeoutMs);

test('buildFixture keeps JARs whose stamp matches the sources without a JDK', async () => {
    await buildFixture(fixtureFolder, undefined);
});

test('buildFixture asks for JAVA_HOME when it has to build without one', async () => {
    const missing = fileURLToPath(new URL('../../artifacts/java-fixture-missing/', import.meta.url));
    rmSync(missing, { recursive: true, force: true });

    await expect(buildFixture(missing, undefined)).rejects.toThrow('Set JAVA_HOME to a JDK 21 or later');
});
