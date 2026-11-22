import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLlvmTool, type LlvmFolders } from '../../native/fixture/build';
import { layOut } from './layout';
import { type FixtureLayout, fixtureLayouts, writeMetadata } from './metadata';
import { type FixtureImage, images, stringLiterals } from './model';
import { writeRegistration } from './registration';

const scriptFolder = fileURLToPath(new URL('.', import.meta.url));
const outputRoot = fileURLToPath(new URL('../../../artifacts/il2cpp-fixture/', import.meta.url));

// keeps the code small and free of a C library, like the native engine's fixture
const compileFlags = ['-O1', '-ffreestanding', '-nostdlib', '-c'];

type Command = [tool: string, ...args: string[]];

const commands: Command[] = [
    ['clang', '--target=x86_64-pc-windows-msvc', ...compileFlags, '-o', 'registration.obj', 'registration.c'],
    // keeps every function apart because the runtime maps each method's pointer to 1 method. The map of the
    // functions' addresses is for the tests of names files.
    ['lld-link', '/dll', '/noentry', '/nodefaultlib', '/opt:noicf', '/Brepro', '/map:GameAssembly.map', '/out:GameAssembly.dll', 'registration.obj'],
    ['clang', '--target=x86_64-linux-gnu', ...compileFlags, '-fPIC', '-o', 'registration.o', 'registration.c'],
    // writes each pointer's value into the data too, besides its relocation, like the data of a build that ran
    ['ld.lld', '-shared', '--apply-dynamic-relocs', '-o', 'libil2cpp.so', 'registration.o'],
    // builds the Thumb code of an Android armv7 game, whose method pointers have bit 0 set, and strips it like Unity
    // does, so only `il2cpp_init` keeps its symbol and no mapping symbol marks the Thumb code
    [
        'clang',
        '--target=armv7-linux-androideabi',
        '-mthumb',
        ...compileFlags,
        '-fPIC',
        '-fvisibility=hidden',
        '-o',
        'registration-32.o',
        'registration-32.c',
    ],
    ['ld.lld', '-shared', '--apply-dynamic-relocs', '--strip-all', '-o', 'libil2cpp-armv7.so', 'registration-32.o'],
];

function run(llvm: LlvmFolders, folder: string, [tool, ...args]: Command) {
    const { exitCode, stderr } = Bun.spawnSync([findLlvmTool(tool, llvm), ...args], { cwd: folder });
    if (exitCode !== 0) {
        throw new Error(`${tool} ${args.join(' ')} failed: ${stderr.toString()}`);
    }
}

/**
 * Writes the fixture's `global-metadata.dat` and builds the matching `GameAssembly.dll`, `libil2cpp.so` and armv7
 * `libil2cpp-armv7.so` with LLVM's tools into a folder, from the fixture's images or from other images for a game of
 * another build, in the 31.1 layout or in another layout.
 */
export function buildFixtureInto(
    folder: string,
    fixtureImages: FixtureImage[] = images,
    metadataLayout: FixtureLayout = fixtureLayouts['31.1'],
): void {
    const layout = layOut(fixtureImages);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'global-metadata.dat'), writeMetadata(layout, stringLiterals, metadataLayout));
    writeFileSync(join(folder, 'registration.c'), writeRegistration(layout, metadataLayout));
    writeFileSync(join(folder, 'registration-32.c'), writeRegistration(layout, metadataLayout, 4));

    const llvm = { llvm: process.env.NATIVE_LLVM || undefined };
    for (const command of commands) {
        run(llvm, folder, command);
    }
}

/**
 * Builds the fixture into a folder below `artifacts/il2cpp-fixture` whose name is a hash of the fixture's scripts,
 * unless the folder is there, and returns the folder.
 */
export function buildFixture(): string {
    const hash = createHash('sha256');
    for (const name of readdirSync(scriptFolder).sort()) {
        hash.update(name).update(readFileSync(join(scriptFolder, name)));
    }

    const folder = join(outputRoot, hash.digest('hex').slice(0, 16));
    if (existsSync(folder)) {
        return folder;
    }

    // builds into another folder and renames it at the end because a build that stops halfway then doesn't leave a
    // folder that the next run takes as whole
    const building = `${folder}.building`;
    rmSync(building, { recursive: true, force: true });
    buildFixtureInto(building);
    renameSync(building, folder);

    return folder;
}
