import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceFolder = fileURLToPath(new URL('src/', import.meta.url));
// runs the SDK from the engine's folder because its global.json picks the SDK there
const engineFolder = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const names = ['Shapes', 'Drawing'];
const targetFramework = 'net11.0';
const stampName = 'fixture.stamp';
// embeds these resources as private and the others as public, because the tree shows each resource's visibility
const privateResources = ['notes.txt'];
// keeps the SDK from calling Microsoft and from printing its welcome text
const sdkEnvironment = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };

function listFiles(folder: string, extension: string): string[] {
    return readdirSync(folder, { recursive: true, encoding: 'utf8' })
        .filter(path => path.endsWith(extension))
        .sort();
}

// hashes the path and text of each source, each resource and this script, because the hash then changes with any edit,
// new file or deleted file
function hashBuild(): string {
    const hash = createHash('sha256');
    const sources = [...listFiles(sourceFolder, '.cs'), ...listFiles(sourceFolder, '.txt')].sort();
    const files = [...sources.map(path => join(sourceFolder, path)), script];

    for (const path of files) {
        hash.update(`\0${relative(sourceFolder, path)}\0`).update(readFileSync(path));
    }

    return hash.digest('hex');
}

function runSdk(dotnet: string, args: string[]): string {
    const { exitCode, stdout, stderr } = Bun.spawnSync([dotnet, ...args], { cwd: engineFolder, env: sdkEnvironment });
    if (exitCode !== 0) {
        throw new Error(`dotnet ${args[0]} failed: ${stdout.toString()}${stderr.toString()}`);
    }

    return stdout.toString().trim();
}

// checks the assemblies against the stamp of their build, and only checks the SDK and its reference pack with an SDK
// because a test without one keeps the assemblies of any SDK
function isFresh(output: string, dotnet: string | undefined): boolean {
    const stamp = join(output, stampName);
    if (![stampName, ...names.map(name => `${name}.dll`)].every(file => existsSync(join(output, file)))) {
        return false;
    }

    const [sources, sdk, references] = readFileSync(stamp, 'utf8').split('\n');
    if (sources !== hashBuild()) {
        return false;
    }

    if (dotnet === undefined) {
        return true;
    }

    const currentSdk = runSdk(dotnet, ['--version']);

    return sdk === currentSdk && references === findCompiler(dotnet, currentSdk).referenceVersion;
}

/** Picks the newest of the versions of packs, like `11.0.0-rc.3.26522.148`, by their order as semantic versions. */
export function pickNewestVersion(versions: string[]): string | undefined {
    return versions.toSorted(Bun.semver.order).at(-1);
}

interface Compiler {
    csc: string;
    references: string[];
    referenceVersion: string;
}

// finds the compiler in the SDK that global.json picks and the reference assemblies of the newest runtime beside it,
// because the fixture then builds without a project and without a restore
function findCompiler(dotnet: string, sdk: string): Compiler {
    const line = runSdk(dotnet, ['--list-sdks']).split('\n').find(entry => entry.startsWith(`${sdk} [`));
    if (!line) {
        throw new Error(`dotnet --list-sdks doesn't list the SDK ${sdk}`);
    }

    const sdkFolder = join(line.slice(sdk.length + 2, -1), sdk);
    const packFolder = join(dirname(dirname(sdkFolder)), 'packs', 'Microsoft.NETCore.App.Ref');
    const version = pickNewestVersion(readdirSync(packFolder).filter(name => existsSync(join(packFolder, name, 'ref', targetFramework))));
    if (!version) {
        throw new Error(`${packFolder} doesn't have reference assemblies for ${targetFramework}`);
    }

    const referenceFolder = join(packFolder, version, 'ref', targetFramework);

    return {
        csc: join(sdkFolder, 'Roslyn', 'bincore', 'csc.dll'),
        references: listFiles(referenceFolder, '.dll').map(path => join(referenceFolder, path)),
        referenceVersion: version,
    };
}

/** The choices of a compile that `compileText` takes beside the text. */
export interface CompileOptions {
    /** The paths of the assemblies that the text references. */
    references?: string[];
    /** Whether the compiler optimizes the IL, which leaves out the `nop`s that a debug build writes. */
    isOptimized?: boolean;
}

// maps the source folder to `/` because the assembly's bytes then don't depend on where the repo is
function compile(
    dotnet: string,
    compiler: Compiler,
    sources: string[],
    assembly: string,
    { references = [], isOptimized = true }: CompileOptions,
    resources: string[] = [],
) {
    runSdk(dotnet, [
        'exec',
        compiler.csc,
        '-nologo',
        '-noconfig',
        '-nostdlib',
        '-deterministic',
        isOptimized ? '-optimize+' : '-optimize-',
        '-debug-',
        '-target:library',
        `-pathmap:${sourceFolder}=/`,
        `-out:${assembly}`,
        ...[...compiler.references, ...references].map(path => `-r:${path}`),
        ...resources.map(path => `-resource:${path},${basename(path)},${privateResources.includes(basename(path)) ? 'private' : 'public'}`),
        ...sources,
    ]);
}

/**
 * Compiles C# text into `<name>.dll` in the output folder with the SDK's compiler, for tests that need an assembly that
 * the fixture doesn't have. Returns the assembly's path.
 */
export async function compileText(dotnet: string, output: string, name: string, text: string, options: CompileOptions = {}): Promise<string> {
    const source = join(output, `${name}.cs`);
    const assembly = join(output, `${name}.dll`);
    await Bun.write(source, text);

    compile(dotnet, findCompiler(dotnet, runSdk(dotnet, ['--version'])), [source], assembly, options);

    return assembly;
}

/**
 * Builds `Shapes.dll` and `Drawing.dll` into the output folder from the fixture's sources and resources with the SDK's
 * compiler, unless the stamp of the assemblies' build matches the sources, the build's script and the SDK.
 */
export async function buildFixture(output: string, dotnet: string | undefined): Promise<void> {
    if (isFresh(output, dotnet)) {
        return;
    }
    if (!dotnet) {
        throw new Error('Install the .NET SDK 11 because the tests build the .NET fixture with it.');
    }

    // removes the stamp first because a build that stops halfway then leaves assemblies without a stamp
    const stamp = join(output, stampName);
    rmSync(stamp, { force: true });

    const sdk = runSdk(dotnet, ['--version']);
    const compiler = findCompiler(dotnet, sdk);

    // compiles into a folder beside the assemblies and renames each into place, because a test file that reads an
    // assembly then never sees half of it
    const buildFolder = join(output, 'build');
    rmSync(buildFolder, { recursive: true, force: true });
    mkdirSync(buildFolder, { recursive: true });

    const built: string[] = [];
    for (const name of names) {
        const sources = listFiles(join(sourceFolder, name), '.cs').map(path => join(sourceFolder, name, path));
        const resources = listFiles(join(sourceFolder, name), '.txt').map(path => join(sourceFolder, name, path));
        const assembly = join(buildFolder, `${name}.dll`);
        compile(dotnet, compiler, sources, assembly, { references: built }, resources);
        built.push(assembly);
    }

    for (const name of names) {
        renameSync(join(buildFolder, `${name}.dll`), join(output, `${name}.dll`));
    }
    rmSync(buildFolder, { recursive: true, force: true });

    await Bun.write(stamp, `${hashBuild()}\n${sdk}\n${compiler.referenceVersion}`);
}
