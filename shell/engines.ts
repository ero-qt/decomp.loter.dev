import type { Engine } from '#contract/engine';
import { type Manifest, matchesFile, readManifest, readStart } from '#contract/manifest';
import { connectEngine } from '#contract/queue';

/** An engine of the site with its manifest. */
export interface SiteEngine {
    manifest: Manifest;
    engine: Engine;
}

type WorkerPolicy = Pick<TrustedTypePolicy, 'createScriptURL'>;

// stops a call after 2 minutes because an engine can take many seconds to open a large file
const timeLimitMs = 120000;
// restarts an engine whose canceled call blocks another call for 1 second, unless its manifest allows longer, because
// the user waits for the other call
const defaultCancelLimitMs = 1000;

/**
 * Returns the URL of an engine's worker and throws for an id that isn't in the site's index or isn't a folder's name.
 */
export function formatWorkerUrl(id: string, engineIds: string[], siteUrl: string): string {
    if (!engineIds.includes(id) || !/^[a-z0-9-]+$/.test(id)) {
        throw new TypeError(`'${id}' isn't the id of one of the site's engines`);
    }

    return new URL(`engines/${id}/worker.js`, siteUrl).href;
}

async function fetchJson(url: URL): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`the site doesn't have ${url.pathname}`);
    }

    return response.json();
}

async function fetchEngineIds(siteUrl: string): Promise<string[]> {
    const engineIds = await fetchJson(new URL('engines/index.json', siteUrl));
    if (!Array.isArray(engineIds) || !engineIds.every(id => typeof id === 'string')) {
        throw new Error("engines/index.json isn't a list of strings");
    }

    return engineIds;
}

async function loadEngine(id: string, engineIds: string[], siteUrl: string, policy?: WorkerPolicy): Promise<SiteEngine> {
    const workerUrl = policy?.createScriptURL(id) ?? formatWorkerUrl(id, engineIds, siteUrl);
    const manifest = readManifest(await fetchJson(new URL(`engines/${id}/manifest.json`, siteUrl)));
    if (manifest.id !== id) {
        throw new Error(`the manifest has the id '${manifest.id}'`);
    }

    const { memoryLimitBytes, hasLinkedFiles, repliesDuringReads, cancelLimitMs = defaultCancelLimitMs } = manifest;
    const options = { timeLimitMs, cancelLimitMs, memoryLimitBytes, hasLinkedFiles, repliesDuringReads };

    return { manifest, engine: connectEngine(workerUrl, options) };
}

/**
 * Loads the manifest of each engine in the site's index and connects the engines. Returns the engines that loaded,
 * higher priority first and then in the index's order, and a text for the user for each engine that didn't load. An
 * engine's worker starts with the engine's first call.
 */
export async function loadEngines(siteUrl: string): Promise<{ engines: SiteEngine[]; errorTexts: string[] }> {
    let engineIds: string[];
    try {
        engineIds = await fetchEngineIds(siteUrl);
    } catch (error) {
        return { engines: [], errorTexts: [`The site couldn't load its engines (${(error as Error).message}).`] };
    }

    // builds each worker's URL in a policy because the site's content security policy requires trusted types for a
    // worker's script
    const policy = self.trustedTypes?.createPolicy('engine-workers', {
        createScriptURL: id => formatWorkerUrl(id, engineIds, siteUrl),
    });
    const results = await Promise.allSettled(engineIds.map(id => loadEngine(id, engineIds, siteUrl, policy)));

    return {
        engines: results
            .flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
            .sort((first, second) => (second.manifest.priority ?? 0) - (first.manifest.priority ?? 0)),
        errorTexts: results.flatMap((result, index) => {
            if (result.status === 'fulfilled') {
                return [];
            }

            return [`The site couldn't load the engine '${engineIds[index]}' (${(result.reason as Error).message}).`];
        }),
    };
}

function hasMagics(engines: SiteEngine[]): boolean {
    return engines.some(({ manifest }) => (manifest.magics ?? []).length > 0);
}

/**
 * Lists each extension in the engines' manifests once, or no extension when an engine has magics, because the file
 * dialog then shows every file.
 */
export function listExtensions(engines: SiteEngine[]): string[] {
    if (hasMagics(engines)) {
        return [];
    }

    return [...new Set(engines.flatMap(({ manifest }) => manifest.extensions))];
}

/**
 * Finds the first engine in the engines' order whose manifest has the extension of the file's name or a magic at the
 * file's start and that claims the file. An engine whose manifest matches neither doesn't get a `claims` call because a
 * `claims` call to every engine would start every engine's worker for each file.
 */
export async function findEngine(engines: SiteEngine[], file: File): Promise<SiteEngine | undefined> {
    const empty = new Uint8Array();
    // only matches extensions for a file whose start can't be read because no engine opens such a file by its magic
    const start = hasMagics(engines) ? await readStart(file).catch(() => empty) : empty;
    for (const candidate of engines) {
        if (matchesFile(candidate.manifest, file.name, start) && (await candidate.engine.claims(file.name, file))) {
            return candidate;
        }
    }

    return undefined;
}
