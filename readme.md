# decomp.loter.dev

decomp.loter.dev is a decompiler that runs entirely in your browser.

The site ships parts of other projects, which [third-party-notices.md](third-party-notices.md) lists with their licenses.

## Hosting

Build the site with these commands:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
```

The build needs the .NET SDK 11.0.100-rc.3.26522.148 on the `PATH` because it publishes the .NET engine with it. `engines/dotnet/global.json` asks for exactly that SDK, because the engine's lock file pins the packages that come with it.

The build puts the site in `artifacts/site`. Serve that folder with a web server. The web server has to send the headers in `shell/headers.ts` with every response, also with a missing file. No file in the repo sets them for you, so add them to the web server's own settings.

The web server also has to send `.wasm` files as `application/wasm`, because the browser compiles them while they load only with that type. The .NET engine's `engines/dotnet/_framework/dotnet.js` keeps its name from build to build. The other files there get a new name when they change, so browsers can cache them for a long time, but not `dotnet.js`.

## Testing

The tests need a JDK 21 or later with `JAVA_HOME` set because they build the Java fixture with it. They also need that .NET SDK on the `PATH` because they build the .NET fixture and publish the .NET engine with it.

AI assisted.
