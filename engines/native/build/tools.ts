import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder with the git submodules of the forks of Rizin and rz-ghidra, which the build compiles. */
export const vendorFolder = fileURLToPath(new URL('../vendor/', import.meta.url));

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
