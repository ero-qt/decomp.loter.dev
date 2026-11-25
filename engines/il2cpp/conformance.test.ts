import { testEngine } from '#contract/conformance';
import { testLoadFailure } from '#contract/conformance-testing';
import { useInThreadWorker } from '#contract/in-thread-worker';
import { fixture } from './fixture';
import { createIl2CppHandlers } from './handlers';
import type { Il2CppRuntime } from './runtime';
import { connectIl2Cpp, loadTestRuntime, useIl2CppEngine } from './testing';

testEngine('il2cpp engine', useIl2CppEngine(), fixture, 120000);

// serves the engine with a loader that fails like a lost connection as often as `failures` and then loads the runtime
function connectWithFailures(failures: number) {
    let failed = 0;
    async function loadFailing(): Promise<Il2CppRuntime> {
        if (failed < failures) {
            failed++;
            throw new Error('Failed to fetch dynamically imported module.');
        }

        return loadTestRuntime();
    }

    useInThreadWorker(() => createIl2CppHandlers(loadFailing));

    return connectIl2Cpp();
}

testLoadFailure('il2cpp engine', connectWithFailures, fixture, 120000);
