import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFramework, type DotnetProject, findFrameworkFolder, publishProject } from '../shared/dotnet/publish';

const engineFolder = fileURLToPath(new URL('.', import.meta.url));
const outputFolder = fileURLToPath(new URL('../../artifacts/dotnet/', import.meta.url));
const sources = readdirSync(join(engineFolder, 'src'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name));
const buildFiles = ['Directory.Build.props', 'global.json', 'build.ts', '../shared/dotnet/publish.ts', '../shared/stamp.ts'];

const project: DotnetProject = {
    projectFolder: join(engineFolder, 'src'),
    sdkFolder: engineFolder,
    outputFolder,
    inputs: [...sources, ...buildFiles.map(path => join(engineFolder, path))],
};

/** The published folder with `dotnet.js`, the runtime and the assemblies, which the worker loads. */
export const frameworkFolder = findFrameworkFolder(project);

/**
 * Publishes the engine's C# project for the browser into `artifacts/dotnet/publish`, unless the stamp of the last
 * publish matches the sources, the build's files and the SDK.
 */
export async function publishEngine(): Promise<void> {
    await publishProject(project);
}

/**
 * Publishes the engine when its stamp is stale and copies the runtime, the assemblies and the runtime's notices into
 * the engine's folder of the site.
 */
export default async function copyIntoSite(siteFolder: string): Promise<void> {
    await copyFramework(project, join(outputFolder, 'obj', 'Decomp.Dotnet', 'project.assets.json'), siteFolder);
}
