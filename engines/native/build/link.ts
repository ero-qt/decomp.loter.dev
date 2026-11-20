import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGhidra, type GhidraObjects } from './ghidra';
import { buildRizin, configureRizin, copyShare, rizinFolder } from './rizin';
import { buildSleigh } from './sleigh';
import { fetchSubprojects, listVendorSubmodules, type VendorSubmodule } from './sources';
import { hashInputs, isStampFresh, readToolVersions, writeStamp } from './stamp';
import { buildEnvironment, findTool, nativeFolder, runTool } from './tools';

const engineFolder = fileURLToPath(new URL('../', import.meta.url));

/**
 * The folder with `rizin.mjs`, `rizin.wasm`, `share` and `sleigh`, which the worker loads, and Rizin's license texts
 * and the links to the submodules' commits, which the site serves with the module's source.
 */
export const moduleFolder = join(nativeFolder, 'out');

/** The names of Rizin's license texts, the GPL 3.0 and the LGPL 3.0. */
export const licenseFiles = ['COPYING', 'COPYING.LESSER'];

/** The name of the file that links the commit of each submodule that the module was built from. */
export const submodulesFile = 'submodules.txt';

const stamp = join(moduleFolder, 'module.stamp');

// keeps the module's growth below 2 GB, where a failed growth returns NULL in C before the browser stops the tab
const linkFlags = [
    '-Oz',
    '-fwasm-exceptions',
    '-sEMULATE_FUNCTION_POINTER_CASTS=1',
    '-sERROR_ON_UNDEFINED_SYMBOLS=1',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sINITIAL_MEMORY=64MB',
    '-sMAXIMUM_MEMORY=2GB',
    '-sSTACK_SIZE=8MB',
    '-sMODULARIZE=1',
    '-sEXPORT_ES6=1',
    '-sEXPORT_NAME=createRizin',
    '-sENVIRONMENT=worker',
    '-sDYNAMIC_EXECUTION=0',
    '-sFORCE_FILESYSTEM=1',
    '-lworkerfs.js',
    '-sEXIT_RUNTIME=0',
    '-sINVOKE_RUN=0',
    '-sEXPORTED_FUNCTIONS=_free,_malloc',
    '-sEXPORTED_RUNTIME_METHODS=FS,UTF8ToString,stringToNewUTF8,HEAPU8',
];

/**
 * Links Rizin's libraries, the decompiler's archive and the engine's own objects into `rizin.mjs` and `rizin.wasm` in
 * the output folder. Names the output relative to the output folder, so no path of the build host gets into the
 * module through its name. The objects keep their absolute paths, which the link doesn't write into the module.
 */
function linkModule(libraries: string[], { archive, printer, glue }: GhidraObjects, output: string): void {
    mkdirSync(output, { recursive: true });

    const objects = [...glue, printer, '-Wl,--start-group', ...libraries, archive, '-Wl,--end-group'];
    runTool([findTool('em++'), '-o', 'rizin.mjs', ...objects, ...linkFlags], output, buildEnvironment(), true);
}

function listFiles(folder: string): string[] {
    return readdirSync(join(engineFolder, folder), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name));
}

/** Lists the versions, glue and build scripts, which the stamp hashes and the site serves with the module. */
export function listModuleInputs(): string[] {
    const buildHook = join(engineFolder, 'build.ts');
    const files = [...listFiles('build'), ...listFiles('src'), ...(existsSync(buildHook) ? [buildHook] : [])];

    return files.sort();
}

// hashes the inputs with the tools' versions and the commits of the submodules
function hashModuleInputs(toolVersions: string): string {
    const commits = listVendorSubmodules().map(({ path, commit }) => `${path} ${commit}`);

    return hashInputs(listModuleInputs(), [toolVersions, ...commits]);
}

// links each submodule's commit on its repo's site, like https://github.com/ero-qt/rizin/tree/<commit>
function writeSubmodules(submodules: VendorSubmodule[], output: string) {
    const lines = submodules.map(({ path, commit, url }) => `${path} ${url.replace(/\.git$/, '')}/tree/${commit}`);
    writeFileSync(join(output, submodulesFile), `${lines.join('\n')}\n`);
}

function checkEmscripten(toolVersions: string) {
    const { emscripten } = JSON.parse(readFileSync(join(engineFolder, 'build', 'versions.json'), 'utf8'));
    if (!toolVersions.split('\n')[0].includes(`) ${emscripten}`)) {
        throw new Error(`The native engine's build needs Emscripten ${emscripten}.`);
    }
}

/**
 * Builds Rizin with rz-ghidra and the engine's glue as a WebAssembly module into `artifacts/native/out`, with Rizin's
 * license texts and the links to the submodules' commits beside it, unless the stamp of the last build matches the
 * inputs. Fetches Rizin's subprojects first when they're missing.
 */
export async function buildModule(): Promise<void> {
    const toolVersions = readToolVersions();
    const inputs = hashModuleInputs(toolVersions);
    if (isStampFresh(stamp, inputs) && existsSync(join(moduleFolder, 'rizin.wasm'))) {
        return;
    }

    // removes the stamp first because a build that stops halfway then leaves a module without a stamp
    checkEmscripten(toolVersions);
    rmSync(stamp, { force: true });
    await fetchSubprojects();

    configureRizin(toolVersions);
    const libraries = buildRizin();
    const objects = buildGhidra();
    buildSleigh(moduleFolder);
    copyShare(moduleFolder);
    linkModule(libraries, objects, moduleFolder);
    for (const name of licenseFiles) {
        copyFileSync(join(rizinFolder, name), join(moduleFolder, name));
    }

    writeSubmodules(listVendorSubmodules(), moduleFolder);

    writeStamp(stamp, inputs);
}
