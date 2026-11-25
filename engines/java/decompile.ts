import type { TokenCollector } from '@run-slicer/vf';
import { type Document, writeTokens } from '#contract/document';
import { failed, ok, type Reply } from '#contract/reply';
import { loadOnce } from '../shared/loading';
import type { OpenFiles } from './describe';
import { findTop } from './files';
import { mapTokens, readAnyClass, type VineflowerToken } from './tokens';

type Vineflower = typeof import('@run-slicer/vf/vf.runtime.js');

// writes every constructor because the rows then always match the text, and never edits the text after the decompile
// because the token offsets point into it
const options = { 'hide-default-constructor': '0', 'new-line-separator': '1', 'indent-string': '    ' };

// imports Vineflower on the first read because listing a file doesn't need it, and imports it again after a failed
// import because the connection can come back
const loadVineflower = loadOnce<Vineflower>(() => import('@run-slicer/vf/vf.runtime.js'));

function readMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// collects the tokens of each class that Vineflower writes by the class's text
function collectTokens(collected: Map<string, VineflowerToken[]>): TokenCollector {
    let current: VineflowerToken[] = [];

    function add(kind: VineflowerToken['kind'], start: number, length: number, isDeclaration: boolean, fields: Partial<VineflowerToken>) {
        current.push({ kind, start, length, isDeclaration, name: '', owner: '', descriptor: '', method: '', index: -1, ...fields });
    }

    return {
        start(content) {
            current = [];
            collected.set(content, current);
        },
        visitClass: (start, length, declaration, name) => add('class', start, length, declaration, { name }),
        visitField: (start, length, declaration, owner, name, descriptor) => add('field', start, length, declaration, { owner, name, descriptor }),
        visitMethod: (start, length, declaration, owner, name, descriptor) => add('method', start, length, declaration, { owner, name, descriptor }),
        visitParameter: (start, length, declaration, owner, method, descriptor, index, name) => {
            add('parameter', start, length, declaration, { owner, method, descriptor, index, name });
        },
        visitLocal: (start, length, declaration, owner, method, descriptor, index, name) => {
            add('local', start, length, declaration, { owner, method, descriptor, index, name });
        },
        end() {},
    };
}

/**
 * Decompiles a top class of an open file with every class nested in it, because Vineflower only writes a nested or
 * an anonymous class into its outer class when it gets both. Throws once the signal aborts, after the load and after
 * the decompile, because Vineflower can't stop in the middle.
 */
export async function writeJava(files: OpenFiles, fileId: number, top: string, signal: AbortSignal): Promise<Reply<Document>> {
    const file = files.get(fileId)!;
    const nested = [...file.classes.keys()].filter(name => name !== top && findTop(file, name) === top);
    const names = [top, ...nested.sort()];
    const collected = new Map<string, VineflowerToken[]>();

    let loaded: Vineflower;
    try {
        loaded = await loadVineflower();
    } catch (error) {
        return failed(`The engine can't load Vineflower: ${readMessage(error)}`);
    }

    signal.throwIfAborted();

    let output: Record<string, string>;
    try {
        output = await loaded.decompile(names, {
            source: name => readAnyClass(files, fileId, name),
            tokenCollector: collectTokens(collected),
            logger: { writeMessage() {} },
            options,
        });
    } catch (error) {
        return failed(`Vineflower can't decompile ${top}: ${readMessage(error)}`);
    }

    signal.throwIfAborted();

    const text = output[top];
    if (typeof text !== 'string') {
        return failed(`Vineflower doesn't write ${top}.`);
    }
    if (text.includes('\r') || !text.endsWith('\n')) {
        return failed(`Vineflower writes ${top} with line ends that the engine can't show.`);
    }

    let mapped: Awaited<ReturnType<typeof mapTokens>>;
    try {
        mapped = await mapTokens(files, fileId, text, collected.get(text) ?? []);
    } catch (error) {
        return failed(`The engine can't read the symbols of ${top}: ${readMessage(error)}`);
    }

    return ok(writeTokens(text, mapped.tokens, mapped.locals));
}
