import type { Fixture } from '#contract/conformance';
import manifest from './manifest.json' with { type: 'json' };
import { readFixture } from './testing';

const metadata = await readFixture('global-metadata.dat');
const scrambled = new Uint8Array(await metadata.bytes());
new DataView(scrambled.buffer).setInt32(4, 0x5a3c9e17, true);

/** The fixture of `global-metadata.dat`, whose binary `GameAssembly.dll` is its companion. */
export const fixture = {
    manifest,
    file: metadata,
    // the fixture's metadata with a scrambled version, like encrypted metadata that keeps the magic
    broken: new File([scrambled], 'global-metadata.dat'),
    // another file of a Unity game's data folder, which starts like neither metadata nor a program
    foreign: new File(['level data'], 'level0.dat'),
    symbol: 'Assembly-CSharp.dll.Shapes.Circle',
    string: 'shapes fixture',
    companion: { file: await readFixture('GameAssembly.dll') },
} satisfies Fixture;
