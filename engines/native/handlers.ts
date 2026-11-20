import { failed, ok, type Reply } from '../../contract/reply';
import { writeRows } from '../../contract/rows';
import type { EngineHandlers } from '../../contract/serve';
import type { MountedFile, MountFile } from './files';
import { claimsNativeFile } from './formats';
import { ModuleError, type NativeModule } from './module';
import { defaultMaxMembers, groupRows } from './rows';

/** A file that the engine opened, with its Rizin session. */
interface NativeFile {
    name: string;
    session: number;
    mounted: MountedFile;
}

// counts the files that any handlers mounted, because a module outlives its handlers in tests and each file then gets
// a folder of its own
let mountCount = 0;

function refuseCall(): Reply<never> {
    return failed("The native engine doesn't have code for this call yet.");
}

// checks whether a binary imports only from mscoree.dll, like a .NET assembly without its CLI header
function isManagedStub(module: NativeModule, session: number): boolean {
    const imports: { libname?: string }[] = JSON.parse(module.runCommand(session, 'iij') || '[]');

    return imports.length > 0 && imports.every(({ libname }) => /^mscoree\.dll$/i.test(libname ?? ''));
}

// returns why the engine can't read the binary of a session's open file, or `undefined` for a binary that it reads
function findRefusal(module: NativeModule, session: number, path: string, name: string): string | undefined {
    if (!module.openSession(session, path)) {
        return `${name} isn't a readable ELF, PE or Mach-O file.`;
    }
    if (isManagedStub(module, session)) {
        return `${name} only imports mscoree.dll, so its code is .NET IL and not machine code.`;
    }

    return undefined;
}

// turns the errors of the module and its files into failed replies, because the worker stays usable after them and a
// later call can load a file that failed to load
function refuseModuleErrors(handlers: EngineHandlers): EngineHandlers {
    const calls = Object.entries(handlers as unknown as Record<string, (...args: never[]) => Promise<Reply<unknown>>>);
    const refusing = calls.map(([name, handler]) => {
        async function refuse(...args: never[]): Promise<Reply<unknown>> {
            try {
                return await handler(...args);
            } catch (error) {
                if (error instanceof ModuleError) {
                    return failed(error.message);
                }

                throw error;
            }
        }

        return [name, refuse];
    });

    return Object.fromEntries(refusing) as unknown as EngineHandlers;
}

/**
 * Returns the native engine's handlers, which load the module with the first call that needs it, because `claims` then
 * reads only the file's headers. Each open file gets a Rizin session. `mountFile` puts the file's bytes where the
 * session reads them.
 */
export function createNativeHandlers(loadModule: () => Promise<NativeModule>, mountFile: MountFile): EngineHandlers {
    const files = new Map<number, NativeFile>();
    let moduleLoad: Promise<NativeModule> | undefined;

    // forgets a failed load, so the next call loads the module again
    function useModule(): Promise<NativeModule> {
        moduleLoad ??= loadModule().catch(error => {
            moduleLoad = undefined;
            throw error;
        });

        return moduleLoad;
    }

    function findFile(fileId: number): Reply<NativeFile> {
        const file = files.get(fileId);

        return file ? ok(file) : failed(`The native engine doesn't have an open file with the id ${fileId}.`);
    }

    // returns the refusal for a file that isn't open, else the refusal of a call that the engine doesn't take yet
    function refuseFileCall(fileId: number): Reply<never> {
        const found = findFile(fileId);

        return found.error !== undefined ? found : refuseCall();
    }

    return refuseModuleErrors({
        async claims(_, file) {
            return ok(await claimsNativeFile(file));
        },
        async open(fileId, name, file, signal) {
            const module = await useModule();
            signal.throwIfAborted();

            const mounted = await mountFile(module.fs, `/files/${++mountCount}`, 'binary', file);
            const session = module.newSession();
            if (session === 0) {
                mounted.unmount();
                return failed(`The engine ran out of memory before it opened ${name}.`);
            }

            const refusal = findRefusal(module, session, mounted.path, name);
            if (refusal !== undefined) {
                module.freeSession(session);
                mounted.unmount();
                return failed(refusal);
            }

            files.set(fileId, { name, session, mounted });

            return ok(undefined);
        },
        async close(fileId) {
            const found = findFile(fileId);
            if (found.error !== undefined) {
                return found;
            }

            (await useModule()).freeSession(found.value.session);
            found.value.mounted.unmount();
            files.delete(fileId);

            return ok(undefined);
        },
        provide: refuseFileCall,
        async list(fileId, signal) {
            const found = findFile(fileId);
            if (found.error !== undefined) {
                return found;
            }

            const module = await useModule();
            signal.throwIfAborted();
            const { rows, note } = groupRows(module.listSymbols(found.value.session, defaultMaxMembers));

            return ok({ ...writeRows(rows), note, missingFiles: [] });
        },
        read: refuseFileCall,
        describe: refuseCall,
        resolve: refuseCall,
        findReferences: refuseCall,
        listStrings: refuseFileCall,
    });
}
