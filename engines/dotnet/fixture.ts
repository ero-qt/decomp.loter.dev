import type { Fixture } from '../../contract/conformance';
import manifest from './manifest.json' with { type: 'json' };
import { peFile, readFixture } from './testing';

/** The fixture of `Drawing.dll`, whose types use `Shapes.dll`. */
export const fixture = {
    manifest,
    file: await readFixture('Drawing.dll'),
    // the headers of an assembly whose CLI header points past the file's end
    broken: new File([peFile({})], 'broken.dll'),
    // the headers of a native PE file, which doesn't have a CLI header
    foreign: new File([peFile({ hasCliHeader: false })], 'tool.exe'),
    symbol: 'Drawing.Painter',
    string: 'héllo ✓',
    linked: { file: await readFixture('Shapes.dll'), token: 'Area', user: 'Drawing.Painter.Paint(Shape)' },
} satisfies Fixture;
