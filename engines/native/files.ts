import type { ModuleFileSystem } from './module';

/** A file in the module's file system, with the function that takes it out again. */
export interface MountedFile {
    path: string;
    unmount(): void;
}

/** Puts a Blob into a new folder of the module's file system under a name. */
export type MountFile = (fs: ModuleFileSystem, folder: string, name: string, file: Blob) => Promise<MountedFile>;

/** Writes a Blob's bytes into the module's memory, for Bun, which can't read a Blob in place like a worker. */
export async function mountInMemory(fs: ModuleFileSystem, folder: string, name: string, file: Blob): Promise<MountedFile> {
    const path = `${folder}/${name}`;
    fs.mkdirTree(folder);
    fs.writeFile(path, await file.bytes());

    return {
        path,
        unmount() {
            fs.unlink(path);
            fs.rmdir(folder);
        },
    };
}
