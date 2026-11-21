import { serveEngine } from '../../contract/serve';
import { mountInWorker } from './files';
import { createNativeHandlers } from './handlers';
import { loadModule, type NativeModule } from './module';

// points at the module beside the worker, which the worker imports by its URL with the first call that needs it
const moduleUrl = new URL('./rizin.mjs', import.meta.url).href;
let loaded: NativeModule | undefined;

async function loadSiteModule(): Promise<NativeModule> {
    loaded = await loadModule(moduleUrl);

    return loaded;
}

serveEngine(self, createNativeHandlers(loadSiteModule, mountInWorker), () => loaded?.readMemoryBytes() ?? 0);
