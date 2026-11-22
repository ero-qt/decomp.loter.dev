import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildStamped } from '../stamp';

// keeps the SDK from calling Microsoft and from printing its welcome text
const sdkEnvironment = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };

/** A C# project that runs in the browser, which `publishProject` publishes. */
export interface DotnetProject {
    /** The folder of the project's `.csproj` file. */
    projectFolder: string;
    /** The folder whose `global.json` picks the SDK. */
    sdkFolder: string;
    /** The folder that the project's `Directory.Build.props` puts `obj`, `bin` and the publish into. */
    outputFolder: string;
    /** The paths of the files that the publish comes from, like the sources and the build's scripts. */
    inputs: string[];
}

function runSdk(sdkFolder: string, args: string[]): string {
    const dotnet = Bun.which('dotnet');
    if (!dotnet) {
        throw new Error('Install the .NET SDK 11 because the build publishes the .NET engine with it.');
    }

    const { exitCode, stdout, stderr } = Bun.spawnSync([dotnet, ...args], { cwd: sdkFolder, env: sdkEnvironment });
    if (exitCode !== 0) {
        throw new Error(`dotnet ${args[0]} failed: ${stdout.toString()}${stderr.toString()}`);
    }

    return stdout.toString().trim();
}

/** Returns the published folder with `dotnet.js`, the runtime and the assemblies, which a worker loads. */
export function findFrameworkFolder({ outputFolder }: DotnetProject): string {
    return join(outputFolder, 'publish', 'wwwroot', '_framework');
}

/**
 * Publishes the project for the browser into the output folder's `publish`, unless the stamp of the last publish
 * matches the inputs and the SDK, and returns the framework folder.
 */
export async function publishProject(project: DotnetProject): Promise<string> {
    const { projectFolder, sdkFolder, outputFolder, inputs } = project;
    const publishFolder = join(outputFolder, 'publish');

    await buildStamped({
        folder: outputFolder,
        inputs,
        toolVersion: runSdk(sdkFolder, ['--version']),
        outputs: ['publish/wwwroot/_framework/dotnet.js'],
        async build() {
            // removes the old files first because a file that the project stopped making then doesn't stay
            rmSync(publishFolder, { recursive: true, force: true });

            // runs the publish without a build server or a reused MSBuild node because the host has little memory
            const options = ['-c', 'Release', '-o', publishFolder, '--disable-build-servers', '-nodeReuse:false', '-maxcpucount:1'];
            runSdk(sdkFolder, ['publish', projectFolder, ...options]);
        },
    });

    return findFrameworkFolder(project);
}

// finds the runtime pack that the publish took its runtime from, in the NuGet folder that the restore used
async function findRuntimePack(assetsFile: string): Promise<string> {
    const assets = await Bun.file(assetsFile).json();
    const [packageFolder] = Object.keys(assets.packageFolders);
    const [framework] = Object.values<{ downloadDependencies: { name: string; version: string }[] }>(assets.project.frameworks);
    const pack = framework.downloadDependencies.find(dependency => dependency.name.startsWith('Microsoft.NETCore.App.Runtime.'));
    if (!pack) {
        throw new Error(`the restore in ${assetsFile} doesn't list a runtime pack`);
    }

    // takes the version out of a range like `[11.0.0, 11.0.0]`
    const version = pack.version.replace(/^\[([^,]+),.*$/, '$1');

    return join(packageFolder, pack.name.toLowerCase(), version);
}

/**
 * Publishes the project when its stamp is stale and copies the runtime, the assemblies and the runtime's notices into
 * a folder of the site. The project's restore wrote the assets file, like `obj/<project>/project.assets.json`.
 */
export async function copyFramework(project: DotnetProject, assetsFile: string, siteFolder: string): Promise<void> {
    cpSync(await publishProject(project), join(siteFolder, '_framework'), { recursive: true });
    cpSync(join(await findRuntimePack(assetsFile), 'THIRD-PARTY-NOTICES.TXT'), join(siteFolder, 'THIRD-PARTY-NOTICES.TXT'));
}
