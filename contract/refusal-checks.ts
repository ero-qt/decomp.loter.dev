import { checkWithFiles, type Fixture, type FixtureWith } from './checking';
import type { Engine } from './engine';
import { matchesFile, readManifest, readStart } from './manifest';
import { EngineError } from './reply';

// throws unless the engine opens and closes the file after it refused another file, because a refusal can't leave the
// worker broken, and keeps the error of the step that failed as the cause
async function requireOpenAfter(engine: Engine, file: File, refused: File): Promise<void> {
    const fileId = await engine.open(file.name, file).catch((error: unknown) => {
        throw new Error(`${file.name} doesn't open after the refusal of ${refused.name}`, { cause: error });
    });
    await engine.close(fileId).catch((error: unknown) => {
        throw new Error(`${file.name} doesn't close after the refusal of ${refused.name}`, { cause: error });
    });
}

// opens a file that the engine has to refuse and returns what `open` threw
async function openRefused(engine: Engine, refused: File): Promise<unknown> {
    function refuseOpenFile(): Promise<void> {
        return Promise.reject(new Error(`${refused.name} is open`));
    }

    return checkWithFiles(engine, [refused], refuseOpenFile).catch((error: unknown) => error);
}

/** Checks that `open` throws an engine error for the broken file and that the engine opens the file after that. */
export async function checkBrokenFile(engine: Engine, { file, broken }: Fixture): Promise<void> {
    if (!((await openRefused(engine, broken)) instanceof EngineError)) {
        throw new Error(`open doesn't throw an engine error for ${broken.name}`);
    }

    await requireOpenAfter(engine, file, broken);
}

/**
 * Checks that the unsupported file matches an extension or a magic of the manifest, that the engine claims it and that
 * `open` throws an engine error for it whose text has the file's name and the fixture's text. Then checks that the
 * engine still opens the file.
 */
export async function checkUnsupportedFile(engine: Engine, { manifest, file, unsupported }: FixtureWith<'unsupported'>): Promise<void> {
    const { name } = unsupported.file;
    if (!matchesFile(readManifest(manifest), name, await readStart(unsupported.file))) {
        throw new Error(`the page doesn't ask the engine about ${name}, which doesn't match an extension or a magic of the manifest`);
    }
    if (!(await engine.claims(name, unsupported.file))) {
        throw new Error(`the engine doesn't claim ${name}`);
    }

    const thrown = await openRefused(engine, unsupported.file);
    if (!(thrown instanceof EngineError)) {
        throw new Error(`open doesn't throw an engine error for ${name}`);
    }
    if (!thrown.message.includes(name) || !thrown.message.includes(unsupported.text)) {
        throw new Error(`the refusal of ${name} is '${thrown.message}', which doesn't have the file's name and '${unsupported.text}'`);
    }

    await requireOpenAfter(engine, file, unsupported.file);
}
