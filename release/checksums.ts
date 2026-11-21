// Writes checksums.txt with the SHA-256 hash of each file that the deploy uploads, which the deploy job then attests.
// Usage: bun release/checksums.ts <site folder>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const checksumsName = 'checksums.txt';
const htaccessPath = fileURLToPath(new URL('../host/htaccess', import.meta.url));

/** The most subjects that `actions/attest-build-provenance` takes in one attestation. */
export const maxSubjects = 1024;

function hashFile(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Lists the hash and path of each file in the site in `sha256sum`'s format, sorted by path. Lists host/htaccess as
 * `.htaccess` because the deploy copies host/htaccess into the site.
 */
export function listChecksums(site: string): string {
    const paths = readdirSync(site, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(site, join(entry.parentPath, entry.name)))
        .filter(path => path !== checksumsName && path !== '.htaccess');
    const files = [['.htaccess', htaccessPath], ...paths.map(path => [path, join(site, path)])]
        .sort(([first], [second]) => (first < second ? -1 : 1));

    if (files.length > maxSubjects) {
        throw new Error(`The site has ${files.length} files, but an attestation takes at most ${maxSubjects}.`);
    }

    return files.map(([path, file]) => `${hashFile(file)}  ${path}\n`).join('');
}

/** Reads each path's hash from the text of a checksums file. */
export function parseChecksums(text: string): Map<string, string> {
    return new Map(
        text.split('\n').filter(line => line !== '').map(line => {
            const [, hash, path] = /^([0-9a-f]{64}) {2}(.+)$/.exec(line) ?? [];
            if (!hash) {
                throw new Error(`${checksumsName} has a broken line: ${line}`);
            }

            return [path, hash];
        }),
    );
}

if (import.meta.main) {
    const site = process.argv[2];
    writeFileSync(join(site, checksumsName), listChecksums(site));
}
