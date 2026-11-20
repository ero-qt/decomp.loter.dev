import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineFolder = fileURLToPath(new URL('.', import.meta.url));
const outputFolder = fileURLToPath(new URL('../../artifacts/dotnet/', import.meta.url));
const publishFolder = join(outputFolder, 'publish');
const stamp = join(outputFolder, 'publish.stamp');
// keeps the SDK from calling Microsoft and from printing its welcome text
const sdkEnvironment = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };

/** The published folder with `dotnet.js`, the runtime and the assemblies, which the worker loads. */
export const frameworkFolder = join(publishFolder, 'wwwroot', '_framework');

function runSdk(args: string[]): string {
    const dotnet = Bun.which('dotnet');
    if (!dotnet) {
        throw new Error('Install the .NET SDK 11 because the build publishes the .NET engine with it.');
    }

    // runs from the engine's folder because its global.json picks the SDK there
    const { exitCode, stdout, stderr } = Bun.spawnSync([dotnet, ...args], { cwd: engineFolder, env: sdkEnvironment });
    if (exitCode !== 0) {
        throw new Error(`dotnet ${args[0]} failed: ${stdout.toString()}${stderr.toString()}`);
    }

    return stdout.toString().trim();
}

// hashes the SDK's version with the path and text of each input of the publish, because the hash then changes with any
// edit, new file or deleted file
function hashInputs(): string {
    const hash = createHash('sha256').update(runSdk(['--version']));
    const sources = readdirSync(join(engineFolder, 'src'), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(engineFolder, join(entry.parentPath, entry.name)));
    const files = [...sources, 'Directory.Build.props', 'global.json', 'build.ts'].sort();

    for (const path of files) {
        hash.update(`\0${path}\0`).update(readFileSync(join(engineFolder, path)));
    }

    return hash.digest('hex');
}

/**
 * Publishes the engine's C# project for the browser into `artifacts/dotnet/publish`, unless the stamp of the last
 * publish matches the sources, the build's files and the SDK.
 */
export async function publishEngine(): Promise<void> {
    const inputs = hashInputs();
    if (existsSync(stamp) && readFileSync(stamp, 'utf8') === inputs && existsSync(join(frameworkFolder, 'dotnet.js'))) {
        return;
    }

    // removes the stamp and the old files first because a publish that stops halfway then leaves no stamp, and a file
    // that the project stopped making doesn't stay
    rmSync(stamp, { force: true });
    rmSync(publishFolder, { recursive: true, force: true });

    // keeps no build server and no MSBuild node running after the publish because the host has little memory
    runSdk(['publish', 'src', '-c', 'Release', '-o', publishFolder, '--disable-build-servers', '-nodeReuse:false', '-maxcpucount:1']);

    await Bun.write(stamp, inputs);
}
