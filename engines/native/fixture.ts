import type { Fixture } from '#contract/conformance';
import { peFile } from '../dotnet/testing';
import manifest from './manifest.json' with { type: 'json' };
import { readFixture } from './testing';

/** The fixture of `shapes-x64.so`, an ELF file with a namespace, classes and a string that its code uses. */
export const elfFixture = {
    manifest,
    file: await readFixture('shapes-x64.so'),
    // an ELF identification followed by text, which no section header table follows
    broken: new File([`\x7fELF${'not an elf file, '.repeat(4)}`], 'broken.so'),
    // the headers of a .NET assembly, which the .NET engine reads
    foreign: new File([peFile({})], 'tool.exe'),
    symbol: 'geometry.Rect',
    string: 'shapes fixture',
    // a PE file without a CLI header that only imports mscoree.dll, so its code is .NET IL
    unsupported: { file: await readFixture('managed-stub.exe'), text: 'only imports mscoree.dll' },
} satisfies Fixture;

/** The fixture of `shapes.dll`, a PE file whose PDB file is its companion. */
export const peFixture = {
    ...elfFixture,
    file: await readFixture('shapes.dll'),
    symbol: 'add',
    companion: { file: await readFixture('shapes.pdb') },
} satisfies Fixture;
