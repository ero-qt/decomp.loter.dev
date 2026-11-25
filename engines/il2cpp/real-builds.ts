import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// the commit of Cpp2IL whose test builds the tests read, so the files don't change under the hashes below
const cpp2ilCommit = 'b5ad444b82267cb1e4b88b8b373c008105bdea52';
const baseUrl = `https://raw.githubusercontent.com/SamboyCoding/Cpp2IL/${cpp2ilCommit}/TestFiles/`;
const downloadFolder = fileURLToPath(new URL('../../artifacts/il2cpp-real/', import.meta.url));

/** A file of a real build with its path below Cpp2IL's `TestFiles` folder and its SHA-256 hash. */
interface BuildFile {
    path: string;
    sha256: string;
}

/** A Windows x64 Unity build of an empty project with 1 or 2 scripts, as Cpp2IL keeps the build for its tests. */
export interface RealBuild {
    binary: BuildFile;
    metadata: BuildFile;
}

/** The builds in Cpp2IL's tests that the engine reads, by their Unity version. */
export const realBuilds = {
    '2019.4.34': {
        binary: { path: 'Simple_2019_4_34/GameAssembly.dll', sha256: '9744feef3e12b108de12674a121e772a229928f77ceb13e7ebdaf5bd588d6f95' },
        metadata: {
            path: 'Simple_2019_4_34/Simple_2019_4_34_Data/il2cpp_data/Metadata/global-metadata.dat',
            sha256: '19ce9d1de2453f0bcdab35c939ae5b5054797a7ff717fd4ba37500ca72fcd1fd',
        },
    },
    '2022.3.35': {
        binary: { path: 'Simple_2022_3_35/GameAssembly.dll', sha256: '68220f503869134ab966f9d6c2eee04d98446638f09d8cac0c7a1fe073e90b65' },
        metadata: {
            path: 'Simple_2022_3_35/Simple_2022_3_35_Data/il2cpp_data/Metadata/global-metadata.dat',
            sha256: '2441635a7c234a1a34deccc6a9906d6f5abcbdab078a38b2bf488a52a4962c48',
        },
    },
} satisfies Record<string, RealBuild>;

/** The metadata of the builds in Cpp2IL's tests whose layout the engine refuses, by their Unity version. */
export const refusedMetadata = {
    '6000.5.0a6': {
        path: 'Simple_6000_5_0_a6/Simple_6000_5_0_a6_Data/il2cpp_data/Metadata/global-metadata.dat',
        sha256: '8e24029b595381c72de8e957fc241d80ff19ecd487352932fed88bcd3aa0db62',
    },
    '6000.6.0b1': { path: 'Simple_6000_6_0_b1/global-metadata.dat', sha256: 'b17275e0225fd97b9478029672fc485e66e8ae3747792ae7b196614edd631584' },
} satisfies Record<string, BuildFile>;

function hash(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Reads a file of a real build, which the first call downloads into `artifacts/il2cpp-real` at the pinned commit.
 * Throws for a file whose hash doesn't match and deletes it, so the next run downloads it again.
 */
export async function readBuildFile({ path, sha256 }: BuildFile): Promise<File> {
    const target = join(downloadFolder, path);
    if (!existsSync(target)) {
        const response = await fetch(`${baseUrl}${path}`);
        if (!response.ok) {
            throw new Error(`downloading ${path} failed with ${response.status} ${response.statusText}`);
        }

        mkdirSync(dirname(target), { recursive: true });
        await Bun.write(target, await response.arrayBuffer());
    }

    const bytes = await Bun.file(target).bytes();
    if (hash(bytes) !== sha256) {
        rmSync(target);
        throw new Error(`${path} doesn't have the SHA-256 hash ${sha256}`);
    }

    return new File([bytes], path.slice(path.lastIndexOf('/') + 1));
}
