import { serveEngine } from '../../contract/serve';
import { mountInMemory } from './files';
import { createNativeHandlers } from './handlers';
import { loadModule, type NativeModule } from './module';

const moduleUrl = new URL('./rizin.mjs', import.meta.url).href;
let loaded: NativeModule | undefined;

async function loadSiteModule(): Promise<NativeModule> {
    loaded = await loadModule(moduleUrl);

    return loaded;
}

serveEngine(self, createNativeHandlers(loadSiteModule, mountInMemory), () => loaded?.readMemoryBytes() ?? 0);
