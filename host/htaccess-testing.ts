/** Reads host/htaccess's lines without their indents. */
export async function readHtaccessLines(): Promise<string[]> {
    return (await Bun.file(new URL('htaccess', import.meta.url)).text()).split('\n').map(line => line.trim());
}

/** Reads the pattern of each `<If>` and `<ElseIf>` in host/htaccess that keeps a file for a year. */
export async function readLongCachePatterns(): Promise<RegExp[]> {
    return (await readHtaccessLines()).flatMap(line => {
        const [, pattern] = /^<(?:Else)?If "%\{REQUEST_URI\} =~ m#(.+)#">$/.exec(line) ?? [];

        return pattern ? [new RegExp(pattern)] : [];
    });
}
