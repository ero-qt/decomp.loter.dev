/** A file that the user picked or dropped. */
export interface PickedFile {
    /** The file's path in a picked or dropped folder, or the file's name for a file without a folder. */
    path: string;
    file: File;
}

/** Opens the file dialog for files with the extensions, or for a folder. */
export function pickFiles(extensions: string[], isFolder = false): Promise<PickedFile[]> {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = isFolder;
    input.accept = extensions.join(',');

    return new Promise(resolve => {
        input.addEventListener('change', () => {
            resolve([...(input.files ?? [])].map(file => ({ path: file.webkitRelativePath || file.name, file })));
        });
        input.addEventListener('cancel', () => resolve([]));
        input.click();
    });
}

function readFolder(folder: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
    const reader = folder.createReader();
    const entries: FileSystemEntry[] = [];

    return new Promise((resolve, reject) => {
        // reads until the reader returns an empty batch because Chromium's reader returns at most 100 entries for each
        // call
        function readBatch() {
            reader.readEntries(batch => {
                if (batch.length === 0) {
                    resolve(entries);
                } else {
                    entries.push(...batch);
                    readBatch();
                }
            }, reject);
        }

        readBatch();
    });
}

async function readEntry(entry: FileSystemEntry): Promise<PickedFile[]> {
    if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));

        return [{ path: entry.fullPath.slice(1), file }];
    }

    const children = await readFolder(entry as FileSystemDirectoryEntry);

    return (await Promise.all(children.map(readEntryOrSkip))).flat();
}

// leaves out an entry that the browser can't read so the folder's other entries still open
function readEntryOrSkip(entry: FileSystemEntry): Promise<PickedFile[]> {
    return readEntry(entry).catch(() => []);
}

function hasFiles(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes('Files') ?? false;
}

/** Opens the files and the folders of each drop on the page, before the workbench gets the drop. */
export function listenForDrops(open: (pickedFiles: PickedFile[]) => void) {
    window.addEventListener('dragover', event => {
        if (hasFiles(event)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);
    window.addEventListener('drop', event => {
        if (!hasFiles(event)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        const reads = [...event.dataTransfer!.items].map(item => {
            const entry = item.webkitGetAsEntry();
            // reads an item without an entry as a plain file because a drop from another page doesn't have entries
            const file = item.getAsFile();

            return entry ? readEntryOrSkip(entry) : file ? [{ path: file.name, file }] : [];
        });
        void Promise.all(reads).then(pickedFiles => open(pickedFiles.flat()));
    }, true);
}
