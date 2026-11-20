import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFile } from '../testing';

const sourceFolder = fileURLToPath(new URL('src/', import.meta.url));
// the scripts that build the JARs: this file and the zip writer in the engine's test helpers
const scripts = [fileURLToPath(import.meta.url), fileURLToPath(new URL('../testing.ts', import.meta.url))];
const names = ['shapes', 'drawing'];
const release = '21';
const stampName = 'fixture.stamp';

function listFiles(folder: string, extension: string): string[] {
    return readdirSync(folder, { recursive: true, encoding: 'utf8' })
        .filter(path => path.endsWith(extension))
        .sort();
}

// hashes the release with the path and text of each source and build script, because the hash then changes with any
// edit, new file or deleted file
function hashBuild(): string {
    const hash = createHash('sha256').update(release);
    const files = [...listFiles(sourceFolder, '.java').map(path => join(sourceFolder, path)), ...scripts];

    for (const path of files) {
        hash.update(`\0${relative(sourceFolder, path)}\0`).update(readFileSync(path));
    }

    return hash.digest('hex');
}

function readJdkVersion(javac: string): string {
    return Bun.spawnSync([javac, '-version']).stdout.toString().trim();
}

// checks the JARs against the stamp of their build, and checks the JDK only with a JDK because a test without one keeps
// the JARs of any JDK
function isFresh(output: string, javac: string | undefined): boolean {
    const stamp = join(output, stampName);
    if (![stampName, ...names.map(name => `${name}.jar`)].every(file => existsSync(join(output, file)))) {
        return false;
    }

    const [sources, jdk] = readFileSync(stamp, 'utf8').split('\n');

    return sources === hashBuild() && (javac === undefined || jdk === readJdkVersion(javac));
}

// compiles with debug information because the engine reads the types of locals from it
function compile(javac: string, name: string, classes: string, classPath: string[]) {
    const sources = listFiles(join(sourceFolder, name), '.java').map(path => join(sourceFolder, name, path));
    const pathOption = classPath.length > 0 ? ['-cp', classPath.join(':')] : [];
    const { exitCode, stderr } = Bun.spawnSync([javac, '-g', '--release', release, '-encoding', 'UTF-8', '-d', classes, ...pathOption, ...sources]);
    if (exitCode !== 0) {
        throw new Error(`javac failed for ${name}: ${stderr.toString()}`);
    }
}

// writes the entries with sorted names and zero timestamps because the JAR's bytes then stay the same between runs, and
// renames the finished JAR into place because a test file that reads it then never sees half a JAR
async function writeJar(output: string, name: string, classes: string) {
    const entries = await Promise.all(listFiles(classes, '.class').map(async path => {
        return { name: path, bytes: await Bun.file(join(classes, path)).bytes() };
    }));

    const jar = join(output, `${name}.jar`);
    await Bun.write(`${jar}.part`, zipFile(entries));
    renameSync(`${jar}.part`, jar);
}

/**
 * Builds `shapes.jar` and `drawing.jar` into the output folder from the fixture's sources with the JDK in the Java
 * home, unless the stamp of the JARs' build matches the sources, the build's scripts and the JDK.
 */
export async function buildFixture(output: string, javaHome: string | undefined): Promise<void> {
    const javac = javaHome && join(javaHome, 'bin', 'javac');
    const hasJavac = javac !== undefined && existsSync(javac);
    if (isFresh(output, hasJavac ? javac : undefined)) {
        return;
    }
    if (!hasJavac) {
        throw new Error('Set JAVA_HOME to a JDK 21 or later with bin/javac because the tests build the Java fixture with it.');
    }

    // removes the stamp first because a build that stops halfway then leaves JARs without a stamp
    const stamp = join(output, stampName);
    rmSync(stamp, { force: true });

    const classFolder = join(output, 'classes');
    rmSync(classFolder, { recursive: true, force: true });
    mkdirSync(classFolder, { recursive: true });

    const shapes = join(classFolder, 'shapes');
    compile(javac, 'shapes', shapes, []);
    await writeJar(output, 'shapes', shapes);

    const drawing = join(classFolder, 'drawing');
    compile(javac, 'drawing', drawing, [shapes]);
    await writeJar(output, 'drawing', drawing);

    await Bun.write(stamp, `${hashBuild()}\n${readJdkVersion(javac)}`);
}
