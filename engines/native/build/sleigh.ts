import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decompilerFolder, findZlibFolder, rzGhidraFolder, writeIfChanged } from './ghidra';
import { findTool, nativeFolder, readJobs, runTool, toolEnvironment } from './tools';

const sleighcFolder = join(nativeFolder, 'work', 'sleighc');
const compilerSources = [
    'xml', 'marshal', 'space', 'float', 'address', 'pcoderaw', 'translate', 'opcodes', 'globalcontext', 'sleigh',
    'pcodeparse', 'pcodecompile', 'sleighbase', 'slghsymbol', 'slghpatexpress', 'slghpattern', 'semantics', 'context',
    'slaformat', 'compression', 'filemanage', 'slgh_compile', 'slghparse', 'slghscan',
];
const zlibSources = ['adler32', 'crc32', 'deflate', 'inflate', 'inftrees', 'inffast', 'trees', 'zutil', 'compress', 'uncompr'];
// processor -> the Sleigh specifications that the module decompiles with
const specifications: Record<string, string[]> = {
    x86: ['x86', 'x86-64'],
    AARCH64: ['AARCH64'],
};

// builds Ghidra's Sleigh compiler for the host, with the host's compilers, because the language files are the same on
// every machine
function buildCompiler(): string {
    const zlib = findZlibFolder();
    const lines = [
        'rule cxx',
        `  command = ${findTool('c++')} -O2 -std=c++20 -I${decompilerFolder} -I${zlib} -c $in -o $out`,
        'rule cc',
        `  command = ${findTool('cc')} -O2 -I${zlib} -c $in -o $out`,
        'rule link',
        `  command = ${findTool('c++')} $in -o $out`,
        ...compilerSources.map(name => `build ${name}.o: cxx ${join(decompilerFolder, `${name}.cc`)}`),
        ...zlibSources.map(name => `build z_${name}.o: cc ${join(zlib, `${name}.c`)}`),
        `build sleighc: link ${[...compilerSources.map(name => `${name}.o`), ...zlibSources.map(name => `z_${name}.o`)].join(' ')}`,
    ];

    mkdirSync(sleighcFolder, { recursive: true });
    writeIfChanged(join(sleighcFolder, 'build.ninja'), `${lines.join('\n')}\n`);
    runTool([findTool('ninja'), '-C', sleighcFolder, '-j', String(readJobs())], sleighcFolder, toolEnvironment(['ninja']), true);

    return join(sleighcFolder, 'sleighc');
}

/**
 * Compiles the language files of x86 and AArch64 into `sleigh/<processor>` of the output, with the processors' other
 * specifications beside them, and lists every file in `sleigh/files.txt`.
 */
export function buildSleigh(output: string): void {
    const sleighc = buildCompiler();
    const processors = join(rzGhidraFolder, 'ghidra', 'ghidra', 'Ghidra', 'Processors');
    const sleigh = join(output, 'sleigh');
    rmSync(sleigh, { recursive: true, force: true });

    const files: string[] = [];
    for (const [processor, names] of Object.entries(specifications)) {
        const languages = join(processors, processor, 'data', 'languages');
        mkdirSync(join(sleigh, processor), { recursive: true });

        for (const name of names) {
            runTool([sleighc, join(languages, `${name}.slaspec`), join(sleigh, processor, `${name}.sla`)], sleighcFolder, process.env);
            files.push(`${processor}/${name}.sla`);
        }

        for (const name of readdirSync(languages).filter(file => /\.(ldefs|pspec|cspec)$/.test(file))) {
            copyFileSync(join(languages, name), join(sleigh, processor, name));
            files.push(`${processor}/${name}`);
        }
    }

    writeFileSync(join(sleigh, 'files.txt'), `${files.sort().join('\n')}\n`);
}
