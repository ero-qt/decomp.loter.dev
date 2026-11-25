import { afterAll, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import type { Fixture } from '#contract/checking';
import { matchesFile, readManifest, readStart } from '#contract/manifest';
import { connectEngine } from '#contract/queue';
import { findEngine, type SiteEngine } from '../../shell/engines';

const enginesFolder = new URL('../', import.meta.url);
const RealWorker = globalThis.Worker;
const workers: Worker[] = [];

// keeps each worker that the engines start, so the file stops them at its end
class KeptWorker extends RealWorker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        workers.push(this);
    }
}

globalThis.Worker = KeptWorker;
afterAll(() => {
    for (const worker of workers) {
        worker.terminate();
    }

    globalThis.Worker = RealWorker;
});

// lists the engines' folders with a manifest, like the site's build, so a new engine's folder joins the test by itself
const ids = readdirSync(enginesFolder, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(new URL(`${entry.name}/manifest.json`, enginesFolder)))
    .map(entry => entry.name)
    .sort();

// connects each engine's worker from its source, higher priority first like the page, because `claims` only needs the
// worker's handlers
const engines: SiteEngine[] = (
    await Promise.all(ids.map(async id => {
        const manifest = readManifest(await Bun.file(new URL(`${id}/manifest.json`, enginesFolder)).json());
        const engine = connectEngine(new URL(`${id}/worker.ts`, enginesFolder).href, { timeLimitMs: 60000, cancelLimitMs: 1000 });

        return { manifest, engine };
    }))
).sort((first, second) => (second.manifest.priority ?? 0) - (first.manifest.priority ?? 0));

// reads the fixtures that an engine's `fixture.ts` exports, which builds the fixture's files first
async function readFixtures(id: string): Promise<Fixture[]> {
    const exported: Record<string, unknown> = await import(new URL(`${id}/fixture.ts`, enginesFolder).href);

    return Object.values(exported).filter((value): value is Fixture => (value as Fixture | undefined)?.file instanceof File);
}

// tests only the engines with a fixture, because an engine like the fake one keeps its fixture elsewhere
for (const id of ids.filter(found => existsSync(new URL(`${found}/fixture.ts`, enginesFolder)))) {
    test(`page gives each of the ${id} engine's fixture files to that engine, which engines of equal or higher priority don't claim`, async () => {
        const own = engines.find(({ manifest }) => manifest.id === id)!;
        const files = (await readFixtures(id)).flatMap(({ file, linked, unsupported }) => [file, linked?.file, unsupported?.file]);

        expect(files.length).toBeGreaterThan(0);
        for (const file of new Set(files.filter(found => found !== undefined))) {
            expect([file.name, (await findEngine(engines, file))?.manifest.id]).toEqual([file.name, id]);

            for (const other of engines.filter(engine => engine !== own && (engine.manifest.priority ?? 0) >= (own.manifest.priority ?? 0))) {
                const isClaimed = matchesFile(other.manifest, file.name, await readStart(file)) && (await other.engine.claims(file.name, file));

                expect([file.name, other.manifest.id, isClaimed]).toEqual([file.name, other.manifest.id, false]);
            }
        }
    }, 600000);
}
