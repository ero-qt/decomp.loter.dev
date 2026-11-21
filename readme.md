# decomp.loter.dev

decomp.loter.dev is a decompiler that runs entirely in your browser.

The [privacy notice](https://decomp.loter.dev/privacy.html) is about what stays in your browser and what the server keeps.

The site ships parts of other projects, which [third-party-notices.md](third-party-notices.md) lists with their licenses.

## Hosting

Build the site with these commands:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
```

The build needs the .NET SDK 11.0.100-rc.3.26522.148 on the `PATH` because it publishes the .NET engine with it. `engines/dotnet/global.json` asks for exactly that SDK, because the engine is built with the packages that come with it.

The build puts the site in `artifacts/site`. Serve that folder with a web server. The web server has to send the headers in `shell/headers.ts` with every response, also with a missing file. For Apache, `host/htaccess` sends them and the cache headers. Put it into the site as `.htaccess`, like the deploy does. `bun release/check-live.ts <site's URL>` then checks a few of the server's responses against `host/htaccess`.

The web server also has to send `.wasm` files as `application/wasm`, because the browser only compiles them while they load with that type. The .NET engine's `engines/dotnet/_framework/dotnet.js` keeps its name from build to build. The other files there get a new name when they change, so browsers can cache them for a long time, but not `dotnet.js`.

The build also builds the native engine's WebAssembly module, so it needs the submodules and the tools that the native engine's tests need, listed below. If you built the module before, set `NATIVE_MODULE` to its folder, like `artifacts/native/out`, and the build copies it without these tools. The CI does that with the module of its native job. The native engine's `rizin.mjs`, `rizin.wasm` and the files in its `share` and `sleigh` folders keep their names from build to build, so browsers shouldn't cache them for long. Its `source` folder has the versions, glue and build scripts that the module was built from, with links to the commits of the forks of Rizin and rz-ghidra. Keep serving that folder with the module, because the LGPL of Rizin asks for it.

## Testing

The tests need a JDK 21 or later with `JAVA_HOME` set because they build the Java fixture with it. They also need that .NET SDK on the `PATH` because they build the .NET fixture and publish the .NET engine with it.

The native engine's tests first build its WebAssembly module from the forks of Rizin and rz-ghidra in `engines/native/vendor`, which are git submodules. Run `git submodule update --init --recursive` after you clone the repo to get them. The build needs Emscripten 6.0.9, Meson, Ninja, git and a C and C++ compiler for the host. Put them on the `PATH`, or set `NATIVE_EMSCRIPTEN`, `NATIVE_MESON` and `NATIVE_NINJA` to their folders. The first build downloads Rizin's Meson subprojects into `engines/native/vendor/rizin/subprojects`, which Rizin's git ignores. Set `NATIVE_SOURCES_SEED` to the `engines/native/vendor` folder of another clone that has them, to copy them from there without a download. `NATIVE_JOBS` sets how many compiles run at once, 2 by default, so the build stays under 1 GB of memory. The first build takes about 17 minutes with 2 jobs, and a build after a change compiles only what changed.

The native engine's tests build their fixture with clang, lld and LLVM's tools like `llvm-lipo`. They take each tool from the folder in `NATIVE_LLVM` when you set it, else from the `PATH`, also under a versioned name like `ld.lld-18`, which Linux packages often use. Only a tool that's in neither comes from Emscripten's LLVM, because emsdk's LLVM builds only WebAssembly. So install a full LLVM, like Ubuntu's `clang`, `lld` and `llvm` packages.

---

AI-assisted.
