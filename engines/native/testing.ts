import { join } from 'node:path';
import { buildFixture } from './fixture/build';

let fixtureBuild: Promise<string> | undefined;

/** Reads a file of the fixture, like `shapes-x64.so`, and builds the fixture first when its sources changed. */
export async function readFixture(name: string): Promise<File> {
    fixtureBuild ??= buildFixture();
    const folder = await fixtureBuild;

    return new File([await Bun.file(join(folder, name)).bytes()], name);
}
