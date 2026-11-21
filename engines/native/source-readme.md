### Source of the native engine's module

`rizin.mjs` and `rizin.wasm` are Rizin with rz-ghidra and Ghidra's decompiler, built for the browser with Emscripten. You can build them again from this folder.

- `submodules.txt` links the commits of the forks of Rizin and rz-ghidra that the module was built from, and the commits of Ghidra and pugixml that rz-ghidra pins. Each change that the forks make for the browser is a commit of its own.
- `build/versions.json` lists the commit or tarball hash of each Meson subproject of Rizin.
- `src` is the engine's own C code, which the module links with them.
- `build` and `build.ts` are the build scripts. `build.ts` copies the result into the site.
- `COPYING` and `COPYING.LESSER` are the texts of the GPL 3.0 and the LGPL 3.0, which Rizin's license refers to.

The whole site, with the code that loads the module, is at https://github.com/ero-qt/decomp.loter.dev. The site's `engines/native/source` folder comes from the commit that the site was built from, so check out the same commit to build the same module. The files here are copies of those in `engines/native` of that commit, which has the forks as git submodules in `engines/native/vendor`.

To build the module, install [Bun](https://bun.sh), Emscripten 6.0.9, Meson, Ninja, git and a C and C++ compiler. Then run these commands in the repository's folder:

```sh
git submodule update --init --recursive
bun install --frozen-lockfile --ignore-scripts
bun test ./engines/native/module.test.ts
```

The test builds the module before it loads it. The build downloads the Meson subprojects into `engines/native/vendor/rizin/subprojects` and writes the module to `artifacts/native/out`. `bun run build` then copies it into the site. The build checks the commit of each subproject and each tarball's SHA-256 hash, so it stops when a subproject isn't the one the site was built from.

To use your own version of Rizin or rz-ghidra, change the code in its submodule or check out another commit there, then build again.
