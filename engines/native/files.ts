import type { ModuleFileSystem, NativeModule } from './module';

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

/**
 * Mounts a Blob into the module's file system with Emscripten's WORKERFS, which reads only the parts of the Blob that
 * Rizin reads, so a large file isn't copied into the module's memory.
 */
export async function mountInWorker(fs: ModuleFileSystem, folder: string, name: string, file: Blob): Promise<MountedFile> {
    fs.mkdirTree(folder);
    fs.mount(fs.filesystems.WORKERFS, { blobs: [{ name, data: file }] }, folder);

    return {
        path: `${folder}/${name}`,
        unmount() {
            fs.unmount(folder);
            fs.rmdir(folder);
        },
    };
}

/**
 * Writes the type, calling convention and format databases that `share/files.txt` lists into the module's file system
 * below `/usr/local/share`, where Rizin's build looks for them. Rizin reads them when it loads a binary.
 */
export async function writeShareFiles(module: NativeModule): Promise<void> {
    const files = new TextDecoder().decode(await module.fetchFile('share/files.txt')).split('\n').filter(Boolean);
    const contents = await Promise.all(files.map(file => module.fetchFile(`share/${file}`)));
    files.forEach((file, index) => {
        const path = `/usr/local/share/${file}`;
        module.fs.mkdirTree(path.slice(0, path.lastIndexOf('/')));
        module.fs.writeFile(path, contents[index]);
    });
}
