import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder with the git submodules of the forks of Rizin and rz-ghidra, which the build compiles. */
export const vendorFolder = fileURLToPath(new URL('../vendor/', import.meta.url));

/** The folder of the native engine's build, with the work trees, Emscripten's cache and the module. */
export const nativeFolder = fileURLToPath(new URL('../../../artifacts/native/', import.meta.url));

// tool -> the variable that can point at the tool or at its folder in place of the PATH
const toolVariables: Record<string, string | undefined> = {
    'emcc': 'NATIVE_EMSCRIPTEN',
    'em++': 'NATIVE_EMSCRIPTEN',
    'emar': 'NATIVE_EMSCRIPTEN',
    'em-config': 'NATIVE_EMSCRIPTEN',
    'meson': 'NATIVE_MESON',
    'ninja': 'NATIVE_NINJA',
};

/**
 * Finds a tool of the native engine's build, like `meson`, in the folder or at the file that its variable points at,
 * else on the PATH. Throws a text with the tool's name when neither has it.
 */
export function findTool(name: string): string {
    const variable = toolVariables[name];
    const setting = variable ? process.env[variable] : undefined;
    if (setting) {
        const path = existsSync(setting) && statSync(setting).isDirectory() ? join(setting, name) : setting;
        if (existsSync(path)) {
            return path;
        }
    }

    const found = Bun.which(name);
    if (!found) {
        const where = variable ? `on the PATH or in ${variable}` : 'on the PATH';
        throw new Error(`Put ${name} ${where} because the native engine's build runs it.`);
    }

    return found;
}

/** Returns the environment for the build's tools, with their folders first on the PATH because they run each other. */
export function toolEnvironment(names: string[]): Record<string, string | undefined> {
    const folders = [...new Set(names.map(name => dirname(findTool(name))))];

    return { ...process.env, PATH: [...folders, process.env.PATH].join(delimiter) };
}

/** Reads `NATIVE_JOBS`, the count of compiles that run at once, 2 by default because the host's memory is small. */
export function readJobs(): number {
    const jobs = Number(process.env.NATIVE_JOBS ?? 2);
    if (!Number.isSafeInteger(jobs) || jobs < 1) {
        throw new Error(`NATIVE_JOBS is ${process.env.NATIVE_JOBS}, which isn't a count of jobs.`);
    }

    return jobs;
}

/**
 * Returns the environment of the build's compiles, with Emscripten's cache in the build's folder because the cache of
 * a system install can be read-only, and with 1 core for Binaryen because its link step takes the most memory.
 */
export function buildEnvironment(): Record<string, string | undefined> {
    const jobs = String(readJobs());

    return {
        ...toolEnvironment(['emcc', 'meson', 'ninja']),
        EM_CACHE: join(nativeFolder, 'em-cache'),
        EMCC_CORES: jobs,
        BINARYEN_CORES: '1',
    };
}

/**
 * Runs a command in a folder and returns its output, or throws with its output. A long step shows its output as it
 * comes, so a log of the build shows how far it got.
 */
export function runTool(command: string[], folder: string, environment: Record<string, string | undefined>, isLong = false): string {
    if (isLong) {
        const { exitCode } = Bun.spawnSync(command, { cwd: folder, env: environment, stdout: 'inherit', stderr: 'inherit' });
        if (exitCode !== 0) {
            throw new Error(`${command.join(' ')} failed`);
        }

        return '';
    }

    const { exitCode, stdout, stderr } = Bun.spawnSync(command, { cwd: folder, env: environment });
    if (exitCode !== 0) {
        throw new Error(`${command.join(' ')} failed: ${stdout.toString()}${stderr.toString()}`);
    }

    return stdout.toString();
}
