# decomp.loter.dev

decomp.loter.dev is a decompiler that runs entirely in your browser.

The site ships parts of other projects, which [third-party-notices.md](third-party-notices.md) lists with their licenses.

## Hosting

Build the site with these commands:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
```

The build puts the site in `artifacts/site`. Serve that folder with a web server. The web server has to send the headers in `shell/headers.ts` with every response, also with a missing file. No file in the repo sets them for you, so add them to the web server's own settings.

AI assisted.
