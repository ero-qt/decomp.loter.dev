import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRizinFlags, rizinFolder } from './rizin';
import { buildEnvironment, findTool, nativeFolder, readJobs, runTool, vendorFolder } from './tools';

const glueFolder = fileURLToPath(new URL('../src/', import.meta.url));
const ghidraFolder = join(nativeFolder, 'work', 'ghidra');

/** The checkout of rz-ghidra's fork, with Ghidra and pugixml in its submodules. */
export const rzGhidraFolder = join(vendorFolder, 'rz-ghidra');

/** The sources of Ghidra's decompiler, below `Ghidra/Features/Decompiler/src/decompile/cpp` of the Ghidra checkout. */
export const decompilerSources = [
    'marshal', 'space', 'float', 'address', 'pcoderaw', 'translate', 'opcodes', 'globalcontext', 'xml', 'capability',
    'architecture', 'options', 'graph', 'cover', 'block', 'cast', 'typeop', 'database', 'cpool', 'comment', 'fspec',
    'action', 'loadimage', 'varnode', 'op', 'type', 'variable', 'varmap', 'jumptable', 'emulate', 'emulateutil', 'flow',
    'userop', 'funcdata', 'funcdata_block', 'funcdata_varnode', 'unionresolve', 'funcdata_op', 'pcodeinject', 'heritage',
    'prefersplit', 'rangeutil', 'ruleaction', 'subflow', 'blockaction', 'merge', 'double', 'coreaction', 'condexe',
    'override', 'dynamic', 'crc32', 'prettyprint', 'printlanguage', 'printc', 'printjava', 'memstate', 'opbehavior',
    'paramid', 'transform', 'string_ghidra', 'stringmanage', 'bitfield', 'expression', 'multiprecision', 'modelrules',
    'constseq', 'libdecomp', 'sleigh_arch', 'sleigh', 'inject_sleigh', 'filemanage', 'semantics', 'slaformat',
    'compression', 'slghsymbol', 'context', 'sleighbase', 'slghpatexpress', 'slghpattern', 'pcodecompile', 'pcodeparse',
    'grammar',
];
// writes the sources' paths in asserts relative to the build's folder or the submodules' folder, so the module doesn't
// show the host's paths
const prefixMap = `-ffile-prefix-map=${nativeFolder}= -ffile-prefix-map=${vendorFolder}=vendor/`;
// lets ninja read the headers that each compile included
const depfileLines = ['  depfile = $out.d', '  deps = gcc'];
// the sources of rz-ghidra's core plugin, without the plugins for the assembler and the analysis
const rzGhidraSources = [
    'core_ghidra', 'RizinArchitecture', 'RizinLoadImage', 'RizinScope', 'RizinTypeFactory', 'RizinCommentDatabase',
    'CodeXMLParse', 'ArchMap', 'RizinPrintC', 'RzCoreMutex', 'PcodeFixupPreprocessor',
];

/** The objects of the decompiler's build that the module links. */
export interface GhidraObjects {
    /** The archive with Ghidra's decompiler, pugixml and rz-ghidra. */
    archive: string;
    /**
     * rz-ghidra's C printer, which the link takes as an object because the archive drops the static object that adds
     * the printer.
     */
    printer: string;
    /** The objects of the engine's own C files in `src`. */
    glue: string[];
}

/** The folder of Ghidra's decompiler sources in the rz-ghidra checkout. */
export const decompilerFolder = join(rzGhidraFolder, 'ghidra', 'ghidra', 'Ghidra', 'Features', 'Decompiler', 'src', 'decompile', 'cpp');

/** Finds the zlib subproject in Rizin's checkout, whose headers Ghidra's decompiler includes. */
export function findZlibFolder(): string {
    const folders = readdirSync(join(rizinFolder, 'subprojects')).filter(name => /^zlib-/.test(name));
    if (folders.length !== 1) {
        throw new Error(`Rizin's checkout has ${folders.length} zlib subprojects where the build needs 1.`);
    }

    return join(rizinFolder, 'subprojects', folders[0]);
}

/** Writes a file only when its text changes, so ninja keeps the outputs of the last run. */
export function writeIfChanged(path: string, text: string): void {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
        writeFileSync(path, text);
    }
}

function listGlue(): string[] {
    return readdirSync(glueFolder).filter(name => name.endsWith('.c')).sort();
}

/**
 * Returns the ninja rules that compile Ghidra's decompiler and pugixml with the include flags, rz-ghidra with Rizin's
 * flags too, and the engine's own C files with Rizin's flags. Each compile writes a depfile, so ninja compiles a source
 * again after a change of a header that it includes.
 */
export function writeCompileRules(includeFlags: string, rizinFlags: string): string[] {
    return [
        `cxx = em++ -O2 -fwasm-exceptions -std=c++20 ${prefixMap} ${includeFlags}`,
        'rule cxx',
        '  command = $cxx -MD -MF $out.d -c $in -o $out',
        ...depfileLines,
        'rule cxxrz',
        `  command = $cxx -DCORELIB -I${join(rzGhidraFolder, 'src')} ${rizinFlags} -MD -MF $out.d -c $in -o $out`,
        ...depfileLines,
        'rule cc',
        `  command = emcc -Oz ${prefixMap} ${rizinFlags} -MD -MF $out.d -c $in -o $out`,
        ...depfileLines,
    ];
}

function writeNinjaFile() {
    const pugixml = join(rzGhidraFolder, 'third-party', 'pugixml', 'src');
    const objects = [
        ...decompilerSources.map(name => `${name}.o`),
        'pugixml.o',
        ...rzGhidraSources.map(name => `rz_${name}.o`),
    ];

    const lines = [
        ...writeCompileRules(`-I${decompilerFolder} -I${findZlibFolder()} -I${pugixml}`, readRizinFlags().join(' ')),
        'rule ar',
        '  command = rm -f $out && emar rcs $out $in',
        ...decompilerSources.map(name => `build ${name}.o: cxx ${join(decompilerFolder, `${name}.cc`)}`),
        `build pugixml.o: cxx ${join(pugixml, 'pugixml.cpp')}`,
        ...rzGhidraSources.map(name => `build rz_${name}.o: cxxrz ${join(rzGhidraFolder, 'src', `${name}.cpp`)}`),
        ...listGlue().map(name => `build glue_${basename(name, '.c')}.o: cc ${join(glueFolder, name)}`),
        `build libghidra.a: ar ${objects.join(' ')}`,
    ];

    writeIfChanged(join(ghidraFolder, 'build.ninja'), `${lines.join('\n')}\n`);
}

/**
 * Compiles Ghidra's decompiler, pugixml and rz-ghidra into 1 archive with WebAssembly's C++ exceptions, and the
 * engine's own C files against Rizin's headers. Returns the objects that the module links.
 */
export function buildGhidra(): GhidraObjects {
    mkdirSync(ghidraFolder, { recursive: true });
    writeNinjaFile();

    const ninja = findTool('ninja');
    runTool([ninja, '-C', ghidraFolder, '-j', String(readJobs())], ghidraFolder, buildEnvironment(), true);

    return {
        archive: join(ghidraFolder, 'libghidra.a'),
        printer: join(ghidraFolder, 'rz_RizinPrintC.o'),
        glue: listGlue().map(name => join(ghidraFolder, `glue_${basename(name, '.c')}.o`)),
    };
}
