import { failed, ok, type Reply } from '../../contract/reply';
import type { EngineHandlers } from '../../contract/serve';
import { hasCliHeader } from './pe';

const csharpView = 'csharp';

function refuseView(view: string): Reply<never> {
    return failed(`The .NET engine doesn't have the view ${view}.`);
}

function refuseFile(fileId: number): Reply<never> {
    return failed(`The .NET engine doesn't have an open file with the id ${fileId}.`);
}

/** Returns the .NET engine's handlers. */
export function createDotnetHandlers(): EngineHandlers {
    return {
        async claims(_, file) {
            return ok(await hasCliHeader(file));
        },
        open(_, name) {
            return failed(`The .NET engine can't open ${name} yet.`);
        },
        close: refuseFile,
        provide: refuseFile,
        list: refuseFile,
        read: refuseFile,
        describe(_, view) {
            return view === csharpView ? ok(null) : refuseView(view);
        },
        resolve() {
            return ok(null);
        },
        findReferences(_, view) {
            return view === csharpView ? ok([]) : refuseView(view);
        },
        listStrings: refuseFile,
    };
}
