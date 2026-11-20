/** A file that the user picked or dropped. */
export interface PickedFile {
    /** The file's path in a picked or dropped folder, or the file's name for a file without a folder. */
    path: string;
    file: File;
}

/**
 * Returns the warning for the picked files that no engine opened, or `undefined` when each file opened. The warning
 * lists each unopened file outside a folder, but a folder gets a warning only when none of the folder's files opened,
 * because a folder often has files that no engine opens.
 */
export function formatUnopenedText(pickedFiles: PickedFile[], unopened: PickedFile[]): string | undefined {
    const names = unopened.filter(({ path }) => !path.includes('/')).map(({ file }) => `'${file.name}'`);
    if (names.length > 0) {
        const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} other files`] : names;

        return `No engine opens ${new Intl.ListFormat('en', { type: 'disjunction' }).format(shown)}.`;
    }

    return unopened.length > 0 && unopened.length === pickedFiles.length ? 'No file in the folder can be opened.' : undefined;
}

/** Opens the file dialog for 1 file or for files with the extensions, or for a folder. */
export function pickFiles(extensions: string[], mode: 'file' | 'files' | 'folder' = 'files'): Promise<PickedFile[]> {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = mode !== 'file';
    input.webkitdirectory = mode === 'folder';
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
