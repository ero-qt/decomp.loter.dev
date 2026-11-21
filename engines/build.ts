import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../contract/manifest';

const site = new URL('../artifacts/site/engines/', import.meta.url);
const ids: string[] = [];

rmSync(site, { recursive: true, force: true });
for (const folder of readdirSync(new URL('.', import.meta.url), { withFileTypes: true })) {
    const source = new URL(`${folder.name}/`, import.meta.url);
    // skips an engine's folder without a manifest because the site only lists an engine once it's whole, and skips the
    // fake engine because only the tests use it, which serve it by themselves
    if (!folder.isDirectory() || !existsSync(new URL('manifest.json', source)) || folder.name === 'fake') {
        continue;
    }

    const { id } = readManifest(await Bun.file(new URL('manifest.json', source)).json());
    if (id !== folder.name) {
        throw new Error(`the manifest in engines/${folder.name} has the id '${id}'`);
    }

    const target = new URL(`${id}/`, site);
    // splits each dynamic import into a chunk beside the worker because the worker then loads a large part, like
    // Vineflower, only on its first use
    await Bun.build({
        entrypoints: [fileURLToPath(new URL('worker.ts', source))],
        outdir: fileURLToPath(target),
        target: 'browser',
        format: 'esm',
        splitting: true,
        naming: { chunk: '[name]-[hash].[ext]' },
        minify: true,
        throw: true,
    });

    // lets an engine add files that it builds by itself, like the .NET runtime and assemblies
    if (existsSync(new URL('build.ts', source))) {
        const { default: buildIntoSite } = await import(fileURLToPath(new URL('build.ts', source)));
        if (typeof buildIntoSite !== 'function') {
            throw new Error(`engines/${id}/build.ts doesn't have a default export that builds into the site`);
        }

        await buildIntoSite(fileURLToPath(target));
    }

    cpSync(new URL('manifest.json', source), new URL('manifest.json', target));
    ids.push(id);
}

await Bun.write(new URL('index.json', site), JSON.stringify(ids.sort()));
