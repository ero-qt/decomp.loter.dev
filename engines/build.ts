import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../contract/manifest';

const site = new URL('../artifacts/site/engines/', import.meta.url);
const ids: string[] = [];

rmSync(site, { recursive: true, force: true });
for (const folder of readdirSync(new URL('.', import.meta.url), { withFileTypes: true })) {
    const source = new URL(`${folder.name}/`, import.meta.url);
    // skips an engine's folder without a manifest because the site lists an engine only once it's whole
    if (!folder.isDirectory() || !existsSync(new URL('manifest.json', source))) {
        continue;
    }

    const { id } = readManifest(await Bun.file(new URL('manifest.json', source)).json());
    if (id !== folder.name) {
        throw new Error(`the manifest in engines/${folder.name} has the id '${id}'`);
    }

    const target = new URL(`${id}/`, site);
    await Bun.build({ entrypoints: [fileURLToPath(new URL('worker.ts', source))], outdir: fileURLToPath(target), minify: true, throw: true });
    cpSync(new URL('manifest.json', source), new URL('manifest.json', target));
    ids.push(id);
}

await Bun.write(new URL('index.json', site), JSON.stringify(ids.sort()));
