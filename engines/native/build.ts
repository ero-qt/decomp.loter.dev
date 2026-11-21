import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModule, licenseFiles, listModuleInputs, moduleFolder, submodulesFile } from './build/link';

const engineFolder = fileURLToPath(new URL('.', import.meta.url));
const moduleFiles = ['rizin.mjs', 'rizin.wasm', 'share', 'sleigh'];

/**
 * Copies the files that rebuild the module into `source`: the pinned versions, the glue, the build scripts, the links
 * to the submodules' commits, Rizin's license texts and a readme with the rebuild steps. Serving them meets the LGPL's
 * duty to give the source of the module's statically linked parts.
 */
function copySource(sourceFolder: string, builtFolder: string): void {
    for (const path of listModuleInputs()) {
        const target = join(sourceFolder, relative(engineFolder, path));
        mkdirSync(dirname(target), { recursive: true });
        cpSync(path, target);
    }

    for (const name of [...licenseFiles, submodulesFile]) {
        cpSync(join(builtFolder, name), join(sourceFolder, name));
    }

    cpSync(join(engineFolder, 'source-readme.md'), join(sourceFolder, 'readme.md'));
}

/**
 * Returns the folder in NATIVE_MODULE, which has a module that another job of the CI built from the same commit, else
 * builds the module when its stamp is stale and returns the module's folder.
 */
async function findBuiltFolder(): Promise<string> {
    if (process.env.NATIVE_MODULE) {
        return resolve(process.env.NATIVE_MODULE);
    }

    await buildModule();

    return moduleFolder;
}

/** Copies the module with its databases, languages and source into the site, and builds it first when it has to. */
export default async function copyIntoSite(siteFolder: string): Promise<void> {
    const builtFolder = await findBuiltFolder();

    for (const name of moduleFiles) {
        cpSync(join(builtFolder, name), join(siteFolder, name), { recursive: true });
    }

    copySource(join(siteFolder, 'source'), builtFolder);
}
