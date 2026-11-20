import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceFolder = fileURLToPath(new URL('src/', import.meta.url));
const source = join(sourceFolder, 'shapes.cpp');
const extrasSource = join(sourceFolder, 'extras.cpp');
const stubSource = join(sourceFolder, 'managed-stub.c');
const bigSource = join(sourceFolder, 'big.c');
const script = fileURLToPath(import.meta.url);
const outputRoot = fileURLToPath(new URL('../../../artifacts/native-fixture/', import.meta.url));

// keeps the code small and free of a C library, and maps the source folder to `/` because the files' bytes then don't
// depend on where the repo is
const compileFlags = ['-O1', '-g', '-fno-exceptions', '-ffreestanding', '-nostdlib', `-ffile-prefix-map=${sourceFolder}=/`, '-c'];
// calls the exported functions directly and not through the procedure linkage table, so a call's C shows the callee
const elfFlags = [...compileFlags, '-fPIC', '-fno-semantic-interposition'];
// links the RTTI of the classes, whose type descriptors point at type_info's vtable in the C runtime that the fixture
// leaves out
const peLinkFlags = ['/dll', '/noentry', '/nodefaultlib', '/debug', '/force:unresolved', '/Brepro'];
const machoLinkFlags = ['-dylib', '-platform_version', 'macos', '11.0', '11.0', '-undefined', 'dynamic_lookup'];

type Command = [tool: string, ...args: string[]];

function buildElf(target: string, name: string, from = source): Command[] {
    return [
        ['clang++', `--target=${target}`, ...elfFlags, '-o', `${name}.o`, from],
        ['ld.lld', '-shared', '-o', `${name}.so`, `${name}.o`],
    ];
}

// writes the PDB's name into the DLL's debug directory without a folder, like a PDB that ships beside its DLL
function buildPe(target: string, name: string): Command[] {
    return [
        ['clang++', `--target=${target}`, ...compileFlags, '-o', `${name}.obj`, source],
        ['lld-link', ...peLinkFlags, `/pdbaltpath:${name}.pdb`, `/pdb:${name}.pdb`, `/out:${name}.dll`, `${name}.obj`],
    ];
}

function buildMacho(arch: string, name: string): Command[] {
    return [
        ['clang++', `--target=${arch}-apple-macos11`, ...compileFlags, '-o', `${name}.o`, source],
        ['ld64.lld', ...machoLinkFlags, '-arch', arch, '-o', `${name}.dylib`, `${name}.o`],
    ];
}

const commands: Command[] = [
    ...buildElf('x86_64-linux-gnu', 'shapes-x64'),
    ['clang++', '--target=x86_64-linux-gnu', ...elfFlags, '-fvisibility=hidden', '-DHIDDEN', '-o', 'shapes-x64-hidden.o', source],
    ['ld.lld', '-shared', '-s', '-o', 'shapes-x64-stripped.so', 'shapes-x64-hidden.o'],
    ...buildElf('aarch64-linux-gnu', 'shapes-a64'),
    ...buildElf('i386-linux-gnu', 'shapes-x86'),
    ...buildPe('x86_64-pc-windows-msvc', 'shapes'),
    ...buildPe('i686-pc-windows-msvc', 'shapes-x86'),
    ...buildMacho('arm64', 'shapes-arm64'),
    ...buildMacho('x86_64', 'shapes-x86_64'),
    ['llvm-lipo', '-create', 'shapes-arm64.dylib', 'shapes-x86_64.dylib', '-output', 'shapes-fat.dylib'],
    ['clang', '--target=x86_64-linux-gnu', ...elfFlags, '-o', 'big-x64.o', bigSource],
    ['ld.lld', '-shared', '-o', 'big-x64.so', 'big-x64.o'],
    ['llvm-dlltool', '-m', 'i386:x86-64', '-d', join(sourceFolder, 'mscoree.def'), '-l', 'mscoree.lib'],
    ['clang', '--target=x86_64-pc-windows-msvc', ...compileFlags, '-o', 'managed-stub.obj', stubSource],
    ['lld-link', '/entry:start', '/subsystem:console', '/nodefaultlib', '/Brepro', '/out:managed-stub.exe', 'managed-stub.obj', 'mscoree.lib'],
    ...buildElf('x86_64-linux-gnu', 'extras-x64', extrasSource),
    // links at the base of a kernel's image, whose addresses lose their low bits as JavaScript numbers
    ['ld.lld', '-shared', '--image-base=0xffffffff80000000', '-o', 'extras-high.so', 'extras-x64.o'],
    ...buildElf('armv7-linux-gnueabihf', 'extras-arm', extrasSource),
    ...buildElf('mips-linux-gnu', 'extras-mips', extrasSource),
    // writes the PDB's name in capitals into the DLL's debug directory, like the builds of many Windows programs do
    ['clang++', '--target=x86_64-pc-windows-msvc', ...compileFlags, '-o', 'extras.obj', extrasSource],
    ['lld-link', ...peLinkFlags, '/pdbaltpath:EXTRAS.PDB', '/pdb:extras.pdb', '/out:extras.dll', 'extras.obj'],
];

/** The folders that the fixture's build looks in for LLVM's tools, besides the PATH. */
export interface LlvmFolders {
    llvm?: string;
    emscripten?: string;
}

// returns the folder of NATIVE_LLVM and the LLVM folder of Emscripten, each `undefined` when it isn't there
function findLlvmFolders(): LlvmFolders {
    const emConfig = Bun.which('em-config');
    const { exitCode, stdout } = emConfig ? Bun.spawnSync([emConfig, 'LLVM_ROOT']) : { exitCode: 1, stdout: '' };

    return { llvm: process.env.NATIVE_LLVM || undefined, emscripten: exitCode === 0 ? stdout.toString().trim() : undefined };
}

function findInFolder(name: string, folder: string | undefined): string | undefined {
    const file = folder === undefined ? undefined : join(folder, name);

    return file !== undefined && existsSync(file) ? file : undefined;
}

// finds the tool on the PATH under its own name, else under the newest of the versioned names that a distribution's
// packages give it, like `ld.lld-18`
function findOnPath(name: string, path: string): string | undefined {
    const folders = path.split(delimiter).filter(Boolean);
    const exact = folders.map(folder => findInFolder(name, folder)).find(file => file !== undefined);
    if (exact) {
        return exact;
    }

    const versioned = new RegExp(`^${name.replace(/[.+]/g, '\\$&')}-(\\d+)$`);
    const found = folders
        .filter(folder => existsSync(folder))
        .flatMap(folder => readdirSync(folder).map(file => ({ path: join(folder, file), version: Number(versioned.exec(file)?.[1]) })))
        .filter(({ version }) => !Number.isNaN(version))
        .sort((first, second) => second.version - first.version)[0];

    return found?.path;
}

/**
 * Finds an LLVM tool, like `ld.lld`, in NATIVE_LLVM's folder, else on the PATH, else in Emscripten's LLVM. Takes
 * Emscripten's LLVM last because the one of emsdk builds only WebAssembly. Throws a text with the tool's name when
 * none of them has it.
 */
export function findLlvmTool(name: string, { llvm, emscripten }: LlvmFolders, path = process.env.PATH ?? ''): string {
    const found = findInFolder(name, llvm) ?? findOnPath(name, path) ?? findInFolder(name, emscripten);
    if (!found) {
        throw new Error(`Put ${name} on the PATH or in NATIVE_LLVM because the tests build the native fixture with it.`);
    }

    return found;
}

function run(llvm: LlvmFolders, folder: string, [tool, ...args]: Command) {
    const { exitCode, stderr } = Bun.spawnSync([findLlvmTool(tool, llvm), ...args], { cwd: folder });
    if (exitCode !== 0) {
        throw new Error(`${tool} ${args.join(' ')} failed: ${stderr.toString()}`);
    }
}

/**
 * Builds the fixture's ELF, PE and Mach-O files with LLVM's tools into a folder below `artifacts/native-fixture`
 * whose name is a hash of the sources and this script, unless the folder is there. Returns the folder.
 */
export async function buildFixture(): Promise<string> {
    const hash = createHash('sha256');
    for (const name of readdirSync(sourceFolder).sort()) {
        hash.update(name).update(readFileSync(join(sourceFolder, name)));
    }

    const folder = join(outputRoot, hash.update(readFileSync(script)).digest('hex').slice(0, 16));
    if (existsSync(folder)) {
        return folder;
    }

    // builds into another folder and renames it at the end because a build that stops halfway then leaves no folder
    // that the next run takes as whole
    const llvm = findLlvmFolders();
    const building = `${folder}.building`;
    rmSync(building, { recursive: true, force: true });
    mkdirSync(building, { recursive: true });

    for (const command of commands) {
        run(llvm, building, command);
    }

    renameSync(building, folder);

    return folder;
}
