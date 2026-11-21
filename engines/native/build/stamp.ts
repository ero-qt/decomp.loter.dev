import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnvironment, findTool, nativeFolder, runTool } from './tools';

const engineFolder = fileURLToPath(new URL('../', import.meta.url));

/** Hashes the path and bytes of each file and then the texts, because the hash then changes with any edit of either. */
export function hashInputs(files: string[], texts: string[] = []): string {
    const hash = createHash('sha256');
    for (const path of files) {
        hash.update(`\0${relative(engineFolder, path)}\0`).update(readFileSync(path));
    }

    for (const text of texts) {
        hash.update(`\0${text}`);
    }

    return hash.digest('hex');
}

/** Checks whether a stamp file has the hash of the current inputs. */
export function isStampFresh(path: string, inputs: string): boolean {
    return existsSync(path) && readFileSync(path, 'utf8') === inputs;
}

/** Writes the hash of the inputs into a stamp file once its step finished. */
export function writeStamp(path: string, inputs: string): void {
    writeFileSync(path, inputs);
}

/**
 * Reads the versions of Emscripten, Meson and Ninja, which the stamps hash because each one changes the output. Runs
 * them in the build's folder and makes the folder first, because a fresh checkout doesn't have it.
 */
export function readToolVersions(folder = nativeFolder): string {
    const environment = buildEnvironment();
    mkdirSync(folder, { recursive: true });

    return ['emcc', 'meson', 'ninja'].map(tool => runTool([findTool(tool), '--version'], folder, environment).trim()).join('\n');
}
