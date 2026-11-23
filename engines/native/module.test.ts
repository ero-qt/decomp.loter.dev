import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LoadError } from '../shared/loading';
import { writeCompileRules } from './build/ghidra';
import { buildModule, moduleFolder } from './build/link';
import { checkConfiguration, listConfigureInputs } from './build/rizin';
import { readToolVersions } from './build/stamp';
import { mountInMemory } from './files';
import { loadModule, type NativeModule } from './module';
import { loadTestModule, readFixture } from './testing';

const repoFolder = fileURLToPath(new URL('../../', import.meta.url));
// gives a host's first build up to an hour, because it compiles Rizin, Ghidra's decompiler and Emscripten's libraries
const buildTimeoutMs = 60 * 60 * 1000;

// writes a `rizin.mjs` whose module has only the given members into the ignored artifacts folder and loads it
async function loadFakeModule(name: string, members: string): Promise<NativeModule> {
    const path = join(repoFolder, 'artifacts', 'native-test', 'fake', `${name}.mjs`);
    await Bun.write(path, `export default async () => ({ ${members} });\n`);

    return loadModule(pathToFileURL(path).href);
}

test('module loads in bun and reports rizin 0.10.0', async () => {
    const module = await loadTestModule();
    const session = module.newSession();

    expect(session).not.toBe(0);
    expect(module.runCommand(session, 'verq').trim()).toBe('0.10.0');
    module.freeSession(session);
}, buildTimeoutMs);

test('second build with the same inputs returns without a compile', async () => {
    await buildModule();
    const wasm = join(moduleFolder, 'rizin.wasm');
    const builtAt = statSync(wasm).mtimeMs;
    const start = performance.now();

    await buildModule();

    expect(statSync(wasm).mtimeMs).toBe(builtAt);
    expect(performance.now() - start).toBeLessThan(10000);
}, buildTimeoutMs);

test("rizin.mjs doesn't have the repo's path", async () => {
    await buildModule();

    expect(await Bun.file(join(moduleFolder, 'rizin.mjs')).text()).not.toContain(repoFolder);
}, buildTimeoutMs);

test("rizin.wasm doesn't have the repo's path", async () => {
    await buildModule();

    expect(Buffer.from(await Bun.file(join(moduleFolder, 'rizin.wasm')).bytes()).includes(repoFolder)).toBe(false);
}, buildTimeoutMs);

test("tool versions read before the build's folder exists", () => {
    const missing = fileURLToPath(new URL('../../artifacts/native-test/missing/', import.meta.url));
    rmSync(missing, { recursive: true, force: true });

    expect(readToolVersions(missing)).toContain('emcc');
});

test("rizin's configure stamp hashes the script that configures it", () => {
    expect(listConfigureInputs()).toContain(fileURLToPath(new URL('build/rizin.ts', import.meta.url)));
});

// writes a configure output like Meson's, with one module step and one host step that the check leaves out
function writeConfiguration(moduleFlags: string, fork: string): string {
    const folder = fileURLToPath(new URL('../../artifacts/native-test/configure/', import.meta.url));
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const hostStep = 'build sdb_gen: c_LINKER_FOR_BUILD sdb.o\n LINK_ARGS = -pthread';
    writeFileSync(join(folder, 'build.ninja'), `build util.o: c_COMPILER util.c\n ARGS = -Oz ${moduleFlags}\n\n${hostStep}\n`);
    writeFileSync(join(folder, 'rz_userconf.h'), ['FORK', 'PTHREAD', 'OPENPTY', 'FORKPTY', 'LOGIN_TTY'].map(name => {
        return `#define HAVE_${name} ${name === 'FORK' ? fork : '0'}`;
    }).join('\n'));

    return folder;
}

test("rizin's configure check passes a configure without the module's thread flags and functions a browser can't run", () => {
    expect(() => checkConfiguration(writeConfiguration('-fPIC', '0'))).not.toThrow();
});

test("rizin's configure check refuses thread flags in a module step and a function that a browser can't run", () => {
    expect(() => checkConfiguration(writeConfiguration('-pthread', '1'))).toThrow(
        "Rizin's configure gave the module -pthread and HAVE_FORK, which the browser can't run.",
    );
});

test("each compile of the decompiler's build writes a depfile, so a changed header compiles its sources again", () => {
    const rules = writeCompileRules('-Iinclude', '-DRIZIN').join('\n').split(/^rule /m).slice(1).map(rule => rule.trimEnd());

    expect(rules.map(rule => rule.slice(0, rule.indexOf('\n')))).toEqual(['cxx', 'cxxrz', 'cc']);
    for (const rule of rules) {
        expect(rule).toContain('-MD -MF $out.d');
        expect(rule).toEndWith('\n  depfile = $out.d\n  deps = gcc');
    }
});

test("disassemble writes each instruction's address, size, text with Rizin's names, raw text and jump, up to a byte budget", async () => {
    const module = await loadTestModule();
    const mounted = await mountInMemory(module.fs, '/files/module-disassemble', 'binary', await readFixture('shapes-x64.so'));
    const session = module.newSession();
    module.openSession(session, mounted.path);
    module.prepareFunction(session, 0x1a30n);

    const addTwice = module.disassemble(session, 0x1a30n, 15, 1024);
    const budgeted = module.disassemble(session, 0x1a30n, 15, 3);
    module.freeSession(session);
    mounted.unmount();

    expect(addTwice).toEqual([
        { addr: '0x1a30', size: 1, text: 'push rbx', opcode: 'push rbx' },
        { addr: '0x1a31', size: 2, text: 'mov ebx, esi', opcode: 'mov ebx, esi' },
        { addr: '0x1a33', size: 5, text: 'call add', opcode: 'call 0x1a20', jump: '0x1a20' },
        { addr: '0x1a38', size: 2, text: 'mov edi, eax', opcode: 'mov edi, eax' },
        { addr: '0x1a3a', size: 2, text: 'mov esi, ebx', opcode: 'mov esi, ebx' },
        { addr: '0x1a3c', size: 1, text: 'pop rbx', opcode: 'pop rbx' },
        { addr: '0x1a3d', size: 2, text: 'jmp add', opcode: 'jmp 0x1a20', jump: '0x1a20' },
    ]);
    expect(budgeted.map(instruction => instruction.addr)).toEqual(['0x1a30', '0x1a31']);
}, buildTimeoutMs);

// a trap leaves the module's stack and heap broken, so the trap has to reach the worker, which then restarts
test("a trap in a listing throws the trap and not a load error, so the worker restarts", async () => {
    const module = await loadFakeModule('trapping', "_session_listing() { throw new WebAssembly.RuntimeError('memory access out of bounds'); }");

    expect(() => module.listSymbols(1, 1000)).toThrow(WebAssembly.RuntimeError);
});

test('a listing above the size of a JavaScript string becomes a load error', async () => {
    const module = await loadFakeModule('long', "_session_listing: () => 8, _free() {}, UTF8ToString() { throw new RangeError('Invalid string length'); }");

    expect(() => module.listSymbols(1, 1000)).toThrow(LoadError);
    expect(() => module.listSymbols(1, 1000)).toThrow("The native engine couldn't read the symbols of the file: Invalid string length");
});
