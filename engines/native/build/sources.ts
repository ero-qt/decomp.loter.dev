import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findTool, runTool, toolEnvironment, vendorFolder } from './tools';
import pinnedVersions from './versions.json' with { type: 'json' };

/** A git submodule at the commit that its repo pins. */
export interface Submodule {
    path: string;
    url: string;
    commit: string;
}

/** A Meson subproject from a wrap file, which is a git repo with `commit` or a tarball with `file` and `sha256`. */
export interface Subproject {
    name: string;
    /** The subproject's folder below `subprojects`. */
    directory: string;
    url: string;
    commit?: string;
    submodules?: Submodule[];
    file?: string;
    sha256?: string;
}

/** The pinned versions of Emscripten and of Rizin's Meson subprojects, from `versions.json`. */
export interface Versions {
    emscripten: string;
    subprojects: Subproject[];
}

/** A submodule below `engines/native/vendor`, with the commit that its checkout has and the URL of its repo. */
export interface VendorSubmodule {
    /** The submodule's folder, relative to the repo. */
    path: string;
    commit: string;
    url: string;
}

/** The choices of `fetchSubprojects`. */
export interface FetchOptions {
    /**
     * A folder whose `rizin/subprojects` an earlier fetch filled, like the `engines/native/vendor` folder of another
     * clone, whose repos and tarballs serve every URL, so the fetch makes no download.
     */
    seed?: string;
    versions?: Versions;
}

const repoFolder = fileURLToPath(new URL('../../../', import.meta.url));
// keeps git's questions and hints out of a build that runs without a terminal
const gitEnvironment = { GIT_TERMINAL_PROMPT: '0', GIT_ADVICE: '0' };

function readHead(folder: string): string {
    return Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: folder }).stdout.toString().trim();
}

/**
 * Lists the submodules below `engines/native/vendor` and the submodules inside them, like Ghidra in rz-ghidra. Throws
 * when one isn't checked out, because the build compiles them.
 */
export function listVendorSubmodules(): VendorSubmodule[] {
    const status = runTool(['git', 'submodule', 'status', '--recursive', '--', vendorFolder], repoFolder, process.env);
    if (status.trim() === '' || /^-/m.test(status)) {
        throw new Error("Run `git submodule update --init --recursive`, because the native engine's build compiles the submodules.");
    }

    const printSubmodule = 'echo "$displaypath $(git rev-parse HEAD) $(git config --file "$toplevel/.gitmodules" "submodule.$name.url")"';
    const lines = runTool(['git', 'submodule', 'foreach', '--quiet', '--recursive', printSubmodule], repoFolder, process.env);

    return lines
        .trim()
        .split('\n')
        .map(line => {
            const [path, commit, url] = line.split(' ');
            return { path, commit, url };
        });
}

// maps each upstream URL to its copy in the seed, the way a normal fetch lays the repos out
function listSeedUrls(seed: string, versions: Versions): Map<string, string> {
    const urls = new Map<string, string>();
    const add = (url: string, path: string) => urls.has(url) || urls.set(url, pathToFileURL(path).href);

    for (const subproject of versions.subprojects) {
        const subprojectFolder = join(seed, 'rizin', 'subprojects', subproject.directory);
        if (subproject.commit) {
            add(subproject.url, subprojectFolder);
        }

        for (const submodule of subproject.submodules ?? []) {
            add(submodule.url, join(subprojectFolder, submodule.path));
        }
    }

    return urls;
}

// rewrites the upstream URLs with git's `insteadOf` through the environment, which writes no config file, and lets git
// use only local repos, so a URL that the seed doesn't serve stops the fetch in place of a download
function seedEnvironment(seed: string, versions: Versions): Record<string, string> {
    const environment: Record<string, string> = { GIT_ALLOW_PROTOCOL: 'file' };
    const urls = [...listSeedUrls(seed, versions)];

    urls.forEach(([url, seedUrl], index) => {
        environment[`GIT_CONFIG_KEY_${index}`] = `url.${seedUrl}.insteadOf`;
        environment[`GIT_CONFIG_VALUE_${index}`] = url;
    });
    environment.GIT_CONFIG_COUNT = String(urls.length);

    return environment;
}

// copies the subprojects' tarballs into Meson's package cache, where Meson checks each hash and takes the tarball
// without a download
function copyTarballs(seed: string, versions: Versions, folder: string) {
    const cache = join(folder, 'subprojects', 'packagecache');
    mkdirSync(cache, { recursive: true });

    for (const { file, sha256 } of versions.subprojects) {
        if (!file) {
            continue;
        }

        const tarball = join(seed, 'rizin', 'subprojects', 'packagecache', file);
        if (!existsSync(tarball) || createHash('sha256').update(readFileSync(tarball)).digest('hex') !== sha256) {
            throw new Error(`The seed doesn't have ${file} with the hash ${sha256}.`);
        }

        copyFileSync(tarball, join(cache, file));
    }
}

// hashes the wrap files and the files in `packagefiles`, which Meson lays over a subproject or applies to it as diffs
function hashWraps(folder: string): string {
    const subprojects = join(folder, 'subprojects');
    const wraps = readdirSync(subprojects)
        .filter(name => name.endsWith('.wrap'))
        .map(name => join(subprojects, name));
    const packageFolder = join(subprojects, 'packagefiles');
    const packageFiles = existsSync(packageFolder)
        ? readdirSync(packageFolder, { recursive: true, withFileTypes: true })
              .filter(entry => entry.isFile())
              .map(entry => join(entry.parentPath, entry.name))
        : [];

    const hash = createHash('sha256');
    for (const path of [...wraps, ...packageFiles].sort()) {
        hash.update(`\0${path.slice(subprojects.length)}\0`).update(readFileSync(path));
    }

    return hash.digest('hex');
}

function checkCommit(folder: string, commit: string) {
    if (readHead(folder) !== commit) {
        throw new Error(`${folder} isn't at commit ${commit}.`);
    }
}

// checks every subproject against its pin, because the build's stamp only has the pins
function checkSubprojects(folder: string, versions: Versions) {
    for (const subproject of versions.subprojects) {
        const subprojectFolder = join(folder, 'subprojects', subproject.directory);
        if (!existsSync(subprojectFolder)) {
            throw new Error(`${folder} doesn't have the subproject ${subproject.name}.`);
        }

        if (subproject.commit) {
            checkCommit(subprojectFolder, subproject.commit);
        }

        for (const submodule of subproject.submodules ?? []) {
            checkCommit(join(subprojectFolder, submodule.path), submodule.commit);
        }
    }
}

/**
 * Fetches the Meson subprojects of Rizin's checkout into its `subprojects` folder, which Rizin's git ignores, and
 * checks each one against its pin. Fetches them again after a change of the wraps or their package files, because
 * Meson applies those only to a new download. Takes the subprojects from the seed when one is given or
 * `NATIVE_SOURCES_SEED` points at one, else from the upstream URLs.
 */
export async function fetchSubprojects(
    folder = join(vendorFolder, 'rizin'),
    { seed = process.env.NATIVE_SOURCES_SEED || undefined, versions = pinnedVersions }: FetchOptions = {},
): Promise<void> {
    const cache = join(folder, 'subprojects', 'packagecache');
    const stamp = join(cache, 'wraps.stamp');
    const wraps = hashWraps(folder);

    if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== wraps) {
        const environment = { ...toolEnvironment(['git', 'meson']), ...gitEnvironment, ...(seed ? seedEnvironment(seed, versions) : {}) };
        const meson = findTool('meson');
        const names = versions.subprojects.map(subproject => subproject.name);

        // removes the subprojects of the last fetch, because Meson keeps a subproject's folder that's there
        runTool([meson, 'subprojects', 'purge', '--confirm', ...names], folder, environment);
        if (seed) {
            copyTarballs(seed, versions, folder);
        }

        runTool([meson, 'subprojects', 'download', ...names], folder, environment);
        mkdirSync(cache, { recursive: true });
        writeFileSync(stamp, wraps);
    }

    checkSubprojects(folder, versions);
}
