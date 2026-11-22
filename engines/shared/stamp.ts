import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoFolder = fileURLToPath(new URL('../../', import.meta.url));
const stampName = 'build.stamp';

/** A build of files that `buildStamped` skips while its stamp matches the inputs and the tool. */
export interface StampedBuild {
    /** The folder of the outputs and the stamp. */
    folder: string;
    /** The paths of the files that the outputs come from, like the sources and the build's scripts. */
    inputs: string[];
    /**
     * The version of the tool that builds the outputs, or `undefined` without the tool, which keeps the outputs of any
     * tool's version.
     */
    toolVersion?: string;
    /** The paths of the outputs in the folder. */
    outputs: string[];
    build: () => Promise<void>;
}

// hashes the path below the repo and the bytes of each input, because the hash then changes with any edit, new file or
// deleted file
function hashInputs(inputs: string[]): string {
    const hash = createHash('sha256');
    for (const path of inputs.toSorted()) {
        hash.update(`\0${relative(repoFolder, path)}\0`).update(readFileSync(path));
    }

    return hash.digest('hex');
}

function isFresh({ folder, inputs, toolVersion, outputs }: StampedBuild): boolean {
    const stamp = join(folder, stampName);
    if (![stampName, ...outputs].every(output => existsSync(join(folder, output)))) {
        return false;
    }

    // keeps the tool's version after the first line, which can take lines of its own
    const [inputsHash, ...versionLines] = readFileSync(stamp, 'utf8').split('\n');
    const stampedVersion = versionLines.join('\n');

    return inputsHash === hashInputs(inputs) && (toolVersion === undefined || stampedVersion === toolVersion);
}

/**
 * Runs the build unless the folder's stamp matches the inputs and the tool's version and every output is there, then
 * writes the stamp. Removes the old stamp first, because a build that stops halfway then doesn't leave a stamp. A build
 * without the tool's version throws for its missing tool itself.
 */
export async function buildStamped(stamped: StampedBuild): Promise<void> {
    if (isFresh(stamped)) {
        return;
    }

    const stamp = join(stamped.folder, stampName);
    rmSync(stamp, { force: true });
    mkdirSync(stamped.folder, { recursive: true });

    await stamped.build();
    await Bun.write(stamp, `${hashInputs(stamped.inputs)}\n${stamped.toolVersion ?? ''}`);
}
