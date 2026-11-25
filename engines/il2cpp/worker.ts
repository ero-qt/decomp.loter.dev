import { serveEngine } from '#contract/serve';
import type { NativeModule } from '../native/module';
import { createIl2CppHandlers } from './handlers';
import { type Il2CppRuntime, loadRuntime } from './runtime';

// points at the .NET engine's runtime in its own folder, whose assembly has this engine's exports too, which the worker
// loads with the first call that needs them
const dotnetUrl = new URL('../dotnet/_framework/dotnet.js', import.meta.url).href;
// points at the native engine's module in its own folder, which decompiles the methods' code with the first read
const nativeModuleUrl = new URL('../native/rizin.mjs', import.meta.url).href;
let runtime: Il2CppRuntime | undefined;
let nativeModule: NativeModule | undefined;

async function loadSiteRuntime(): Promise<Il2CppRuntime> {
    runtime = await loadRuntime(dotnetUrl);

    return runtime;
}

// imports the native engine's code with the first read that needs it, which keeps the worker small
async function createNative() {
    const { createSiteNativeHandlers } = await import('./native-site');

    return createSiteNativeHandlers(nativeModuleUrl, module => {
        nativeModule = module;
    });
}

const readMemoryBytes = () => (runtime?.readMemoryBytes() ?? 0) + (nativeModule?.readMemoryBytes() ?? 0);

serveEngine(self, createIl2CppHandlers(loadSiteRuntime, createNative), readMemoryBytes);
