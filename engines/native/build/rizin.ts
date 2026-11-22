import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashInputs, isStampFresh, writeStamp } from './stamp';
import { buildEnvironment, findTool, nativeFolder, readJobs, runTool, vendorFolder } from './tools';

const crossFile = fileURLToPath(new URL('emscripten.ini', import.meta.url));
const versionsFile = fileURLToPath(new URL('versions.json', import.meta.url));
const script = fileURLToPath(import.meta.url);
const workFolder = join(nativeFolder, 'work');

/** The checkout of Rizin's fork, which the other steps read sources and subprojects from. */
export const rizinFolder = join(vendorFolder, 'rizin');

/** Rizin's build folder, with the static libraries, the databases and `compile_commands.json`. */
export const rizinBuildFolder = join(workFolder, 'rizin-build');

// only builds the static libraries, without the debugger, GPL code or system libraries
const mesonOptions = [
    '--buildtype=plain',
    '--default-library=static',
    '--prefer-static',
    '-Dstatic_runtime=true',
    '-Duse_gpl=false',
    '-Duse_lzma=false',
    '-Duse_zlib=true',
    '-Denable_tests=false',
    '-Denable_rz_test=false',
    '-Dcli=enabled',
    '-Dportable=true',
    '-Ddebugger=false',
    '-Duse_sys_capstone=disabled',
    '-Duse_sys_magic=disabled',
    '-Duse_sys_libzip=disabled',
    '-Duse_sys_zlib=disabled',
    '-Duse_sys_lz4=disabled',
    '-Duse_sys_xxhash=disabled',
    '-Duse_sys_openssl=disabled',
    '-Duse_sys_tree_sitter=disabled',
    '-Duse_sys_pcre2=disabled',
    '-Duse_sys_lzma=disabled',
    '-Duse_sys_libzstd=disabled',
];
// the configure checks find these functions in Emscripten's headers, but the browser can't run them
const missingFeatures = ['HAVE_FORK', 'HAVE_PTHREAD', 'HAVE_OPENPTY', 'HAVE_FORKPTY', 'HAVE_LOGIN_TTY', 'HAVE_JEMALLOC'];

function listNinjaFiles(folder: string): string[] {
    return readdirSync(folder, { recursive: true, encoding: 'utf8' })
        .filter(path => path.endsWith('.ninja'))
        .map(path => join(folder, path));
}

// drops the thread flags that Meson adds, because a module without threads can't link them, and turns off the
// functions that the configure checks found
function fixConfiguration() {
    for (const path of listNinjaFiles(rizinBuildFolder)) {
        const text = readFileSync(path, 'utf8');
        const fixed = text.replace(/ -pthread| "-pthread"| --shared-memory| --import-memory/g, '');
        writeFileSync(path, fixed);
    }

    const userconf = join(rizinBuildFolder, 'rz_userconf.h');
    const features = new RegExp(`#define (${missingFeatures.join('|')}) .*1`, 'g');
    writeFileSync(userconf, readFileSync(userconf, 'utf8').replace(features, '#define $1 0'));
}

/** Lists the files that Rizin's configure depends on: the versions, the cross file and this script. */
export function listConfigureInputs(): string[] {
    return [versionsFile, crossFile, script];
}

/**
 * Configures the build of Rizin's checkout with Meson in a folder outside of it, so the checkout stays clean, unless
 * the stamp of the last configure matches the checkout's commit, the versions, the cross file, this script, the
 * options and the tools.
 */
export function configureRizin(toolVersions: string): void {
    const stamp = join(workFolder, 'rizin.stamp');
    const commit = runTool(['git', 'rev-parse', 'HEAD'], rizinFolder, process.env).trim();
    const inputs = hashInputs(listConfigureInputs(), [toolVersions, commit, ...mesonOptions]);
    if (isStampFresh(stamp, inputs) && existsSync(join(rizinBuildFolder, 'build.ninja'))) {
        return;
    }

    rmSync(stamp, { force: true });
    rmSync(rizinBuildFolder, { recursive: true, force: true });
    mkdirSync(workFolder, { recursive: true });

    // configures with a copy of the cross file because Meson configures again when the file at its path changes, and a
    // new configure would undo the fixes
    const workCrossFile = join(workFolder, 'emscripten.ini');
    copyFileSync(crossFile, workCrossFile);
    const meson = findTool('meson');
    runTool([meson, 'setup', rizinBuildFolder, rizinFolder, '--cross-file', workCrossFile, ...mesonOptions], workFolder, buildEnvironment(), true);
    fixConfiguration();

    writeStamp(stamp, inputs);
}

function runNinja(args: string[]): string {
    return runTool([findTool('ninja'), '-C', rizinBuildFolder, ...args], workFolder, buildEnvironment());
}

/**
 * Builds the static libraries that Rizin's executable links and the type and format databases, and returns the paths
 * of the libraries in their link order.
 */
export function buildRizin(): string[] {
    // lets Meson configure again before the build and fixes the configuration again, because Ninja runs Meson again when
    // a file of the checkout is newer than the build folder, like after a fresh clone in CI. That configure undoes the
    // fixes.
    runNinja(['build.ninja']);
    fixConfiguration();

    const linkCommand = runNinja(['-t', 'commands', 'binrz/rizin/rizin.js']).trim().split('\n').at(-1) ?? '';
    const libraries = linkCommand.split(' ').filter(part => part.endsWith('.a'));
    const databases = runNinja(['-t', 'targets', 'all'])
        .split('\n')
        .map(line => line.slice(0, line.indexOf(':')))
        .filter(target => target.endsWith('.sdb'));

    const ninja = findTool('ninja');
    const command = [ninja, '-C', rizinBuildFolder, '-j', String(readJobs()), ...libraries, ...databases];
    runTool(command, workFolder, buildEnvironment(), true);

    return libraries.map(library => join(rizinBuildFolder, library));
}

/** Reads the include folders and defines of a source in Rizin's core, so other code compiles with the same headers. */
export function readRizinFlags(): string[] {
    const commands: { file: string; command: string; directory: string }[] = JSON.parse(
        readFileSync(join(rizinBuildFolder, 'compile_commands.json'), 'utf8'),
    );
    const core = commands.find(entry => entry.file.includes('/librz/core/'));
    if (!core) {
        throw new Error("Rizin's compile_commands.json doesn't have a source of librz/core.");
    }

    return core.command
        .split(' ')
        .filter(flag => /^-[ID]/.test(flag))
        .map(flag => (/^-I[^/]/.test(flag) ? `-I${join(core.directory, flag.slice(2))}` : flag));
}

// leaves out the databases of the other architectures and the ordinals of the MFC libraries, which take more than half
// of the space
const otherArchitectures = /-(avr|hexagon|m68k|mips|ppc|riscv|sparc|spc700|sysz|tms320|tricore|xtensa|8051)/;

/**
 * Copies the type, calling convention and format databases of x86 and ARM into `share/rizin` of the output, at the
 * paths that `meson install` gives them, and lists them in `share/files.txt`.
 */
export function copyShare(output: string): void {
    const installed: Record<string, string> = JSON.parse(readFileSync(join(rizinBuildFolder, 'meson-info', 'intro-installed.json'), 'utf8'));
    const share = join(output, 'share');
    rmSync(share, { recursive: true, force: true });

    const files: string[] = [];
    for (const [from, to] of Object.entries(installed)) {
        const path = to.split('/share/rizin/')[1];
        const isWanted = path !== undefined && /^(types|format|reg)\//.test(path) && !otherArchitectures.test(path) && !/mfc\d/.test(path);
        if (from.endsWith('.sdb') && isWanted) {
            mkdirSync(dirname(join(share, 'rizin', path)), { recursive: true });
            copyFileSync(from, join(share, 'rizin', path));
            files.push(`rizin/${path}`);
        }
    }

    writeFileSync(join(share, 'files.txt'), `${files.sort().join('\n')}\n`);
}
