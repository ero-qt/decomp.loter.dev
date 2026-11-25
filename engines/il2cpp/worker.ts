import { serveEngine } from '#contract/serve';
import { createIl2CppHandlers } from './handlers';
import { type Il2CppRuntime, loadRuntime } from './runtime';

// points at the .NET engine's runtime in its own folder, whose assembly has this engine's exports too, which the worker
// loads with the first call that needs them
const dotnetUrl = new URL('../dotnet/_framework/dotnet.js', import.meta.url).href;
let runtime: Il2CppRuntime | undefined;

async function loadSiteRuntime(): Promise<Il2CppRuntime> {
    runtime = await loadRuntime(dotnetUrl);

    return runtime;
}

serveEngine(self, createIl2CppHandlers(loadSiteRuntime), () => runtime?.readMemoryBytes() ?? 0);
