import { serveEngine } from '#contract/serve';
import { createDotnetHandlers } from './handlers';
import { type DotnetRuntime, loadRuntime } from './runtime';

// points at the runtime's files beside the worker, which the worker loads with the first call that needs them
const dotnetUrl = new URL('./_framework/dotnet.js', import.meta.url).href;
let runtime: DotnetRuntime | undefined;

async function loadSiteRuntime(): Promise<DotnetRuntime> {
    runtime = await loadRuntime(dotnetUrl);

    return runtime;
}

serveEngine(self, createDotnetHandlers(loadSiteRuntime), () => runtime?.readMemoryBytes() ?? 0);
