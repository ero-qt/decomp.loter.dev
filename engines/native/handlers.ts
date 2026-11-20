import { failed, ok, type Reply } from '../../contract/reply';
import type { EngineHandlers } from '../../contract/serve';
import { claimsNativeFile } from './formats';

function refuseFiles(): Reply<never> {
    return failed("The native engine can't open files yet.");
}

/** Returns the native engine's handlers, which claim files from their headers and refuse the other calls. */
export function createNativeHandlers(): EngineHandlers {
    return {
        async claims(_, file) {
            return ok(await claimsNativeFile(file));
        },
        open: refuseFiles,
        close: refuseFiles,
        provide: refuseFiles,
        list: refuseFiles,
        read: refuseFiles,
        describe: refuseFiles,
        resolve: refuseFiles,
        findReferences: refuseFiles,
        listStrings: refuseFiles,
    };
}
