import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture } from './fixture/build';

/** The folder that the tests build the fixture's JARs into. */
export const fixtureFolder = fileURLToPath(new URL('../../artifacts/java-fixture/', import.meta.url));

async function readJar(name: string): Promise<File> {
    return new File([await Bun.file(join(fixtureFolder, name)).bytes()], name);
}

await buildFixture(fixtureFolder, process.env.JAVA_HOME);

/** The fixture of `drawing.jar`, whose classes use `shapes.jar`. */
export const fixture = {
    file: await readJar('drawing.jar'),
    // a zip file's local header followed by bytes that aren't a zip file's
    broken: new File(['PK\x03\x04', 'not a zip file'], 'broken.jar'),
    // the start of a fat Mach-O file with 2 architectures, which starts like a class file
    foreign: new File([Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2, 0, 0, 0, 7, 0, 0, 0, 3)], 'tool'),
    symbol: 'drawing.Main',
    string: 'héllo ✓',
    linked: { file: await readJar('shapes.jar'), token: 'area', user: 'drawing.Main', withoutMissingFile: true },
};
