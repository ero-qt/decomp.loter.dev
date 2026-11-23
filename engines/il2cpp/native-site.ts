import { mountInWorker } from '../native/files';
import { createNativeHandlers, type NativeHandlers } from '../native/handlers';
import { loadModule, type NativeModule } from '../native/module';

/**
 * Returns native engine handlers that load the native engine's module from the site. The worker imports this file with
 * the first read that needs it. `keep` gets the loaded module, whose memory's size the worker reports.
 */
export function createSiteNativeHandlers(moduleUrl: string, keep: (module: NativeModule) => void): NativeHandlers {
    return createNativeHandlers(async () => {
        const module = await loadModule(moduleUrl);
        keep(module);

        return module;
    }, mountInWorker);
}
