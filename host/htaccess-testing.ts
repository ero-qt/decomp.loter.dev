/** Reads host/htaccess's lines without their indents. */
export async function readHtaccessLines(): Promise<string[]> {
    return (await Bun.file(new URL('htaccess', import.meta.url)).text()).split('\n').map(line => line.trim());
}

/** Reads the pattern of each `SetEnvIf` in host/htaccess that marks a file to keep for a year. */
export async function readLongCachePatterns(): Promise<RegExp[]> {
    return (await readHtaccessLines()).flatMap(line => {
        const [, pattern] = /^SetEnvIf Request_URI "(.+)" long_cache$/.exec(line) ?? [];

        return pattern ? [new RegExp(pattern)] : [];
    });
}
