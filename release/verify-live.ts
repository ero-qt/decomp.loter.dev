// Checks that the files of the live site match a checksums file, like the release's copy that `gh attestation verify`
// checked, or else the site's own checksums.txt.
// Usage: bun release/verify-live.ts [site URL] [checksums file]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseChecksums } from './checksums';

async function fetchFile(url: URL): Promise<Uint8Array> {
    const response = await fetch(url, { redirect: 'manual' });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${url.pathname.slice(1)} has the status ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetches each file that the checksums text lists, or else the site's `checksums.txt`, and returns the count of checked
 * files with each file that doesn't match. Leaves out `.htaccess` because the host doesn't send it.
 */
export async function verifyLiveFiles(siteUrl: URL, checksumsText?: string): Promise<{ checkedCount: number; problems: string[] }> {
    checksumsText ??= new TextDecoder().decode(await fetchFile(new URL('/checksums.txt', siteUrl)));
    const checksums = parseChecksums(checksumsText);
    checksums.delete('.htaccess');

    const problems: string[] = [];
    for (const [path, hash] of checksums) {
        try {
            const bytes = await fetchFile(new URL(`/${path}`, siteUrl));
            if (createHash('sha256').update(bytes).digest('hex') !== hash) {
                problems.push(`${path} doesn't match its checksum`);
            }
        } catch (error) {
            problems.push((error as Error).message);
        }
    }

    return { checkedCount: checksums.size, problems };
}

if (import.meta.main) {
    const [url = 'https://decomp.loter.dev', checksumsPath] = Bun.argv.slice(2);
    const checksumsText = checksumsPath ? readFileSync(checksumsPath, 'utf8') : undefined;
    const { checkedCount, problems } = await verifyLiveFiles(new URL(url), checksumsText);
    if (problems.length > 0) {
        console.error(problems.join('\n'));
        process.exit(1);
    }

    console.log(`All ${checkedCount} files match ${checksumsPath ?? "the site's checksums.txt"}.`);
}
