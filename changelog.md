# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The .NET engine runs on the final .NET 11 runtime (11.0.0). Building the site needs the .NET SDK 11.0.100 or a later 11.0 SDK.

### Fixed

- A collapsed file's row in the Symbols view clears the error of a picked companion file once a later pick works.
- A deploy job that I run again after the site switched to its release goes through. The host drops an upload with the same files as the live release and keeps the live balance.
- The .NET engine skips a type reference or a generic type that points back at itself in a broken file, so opening the C# of a type in that file can't crash the engine.
- The Java engine skips a class with a broken switch instruction and counts it with the classes it can't read, so that class can't freeze the engine.
- The native engine starts over after it crashes inside Rizin or Ghidra while it lists, decompiles or searches a file. Before, the next clicks could fail in odd ways until you reloaded the page.

### Security

- The host refuses a release with a FIFO or another file that isn't a plain file. It also removes a release that fails its checks, so a broken upload doesn't push out one of the 3 releases I keep.
- A folder like `/assets/` shows the site's own page with the site's security headers when the host refuses to list it, instead of the host's bare 403 page.
- The host copies an upload into its release folder before it checks the files, so an upload that's still running can't sneak files into a release after the checks.

## [1.2.1] - 2026-11-22

### Fixed

- The Symbols view shows its loading strip while a document loads, so a slow first click on a native function doesn't look like nothing happened. Go to Definition and the views you open to the side show it too.
- The first C document of a native file opens sooner, because the native engine starts loading the processor's files for Ghidra right after the file opens.
- The view for native machine code is called Assembly now, like the language it shows, so its menu item reads Show Assembly to the Side.

## [1.2.0] - 2026-11-22

### Changed

- The .NET engine keeps strings of up to 1,000 characters whole and cuts longer ones like the other engines do.
- When an engine fails to load, the error starts with the engine, like "The native engine couldn't load …". The .NET engine tries its runtime again after a failed load.
- The About tab's Supported files table lists every extension that an engine opens, like `.winmd`.

### Fixed

- The Disassembly view opens long functions about 3 times faster and shows up to 256 KB of a function, twice as much as before.

## [1.1.0] - 2026-11-22

### Added

- Java classes get a Bytecode view. It shows each method's instructions below Java-like declarations of the class and its members, with the instructions and keywords in color.
- Native functions and classes get a Disassembly view with each instruction after its address and the mnemonics and registers in color. A call has the name of the function it calls. A jump inside the function has a label that takes you to the line it jumps to.

## [1.0.4] - 2026-11-21

### Fixed

- The About tab lists Ctrl+P, then # for the symbol search, because browsers open a new tab on Ctrl+T.
- The About, Support and Privacy tabs scroll with a swipe on touch screens.
- Keywords, strings and numbers get their colors sooner, because the site loads an engine's grammars while the engine opens the first file.

## [1.0.3] - 2026-11-21

### Added

- The About tab shows the site's version and commit, with links to the release and the commit on GitHub.
- Each deploy signs the hash of every site file through GitHub's artifact attestations and serves the hashes as `checksums.txt`, which the release also has.
- `release/verify-live.ts` checks the live site's files against `checksums.txt`.
- The Support tab points to Wise and Revolut for transfers from outside the EU.

## [1.0.2] - 2026-11-21

### Fixed

- The site's description in link previews leaves out who made the site.

## [1.0.1] - 2026-11-21

### Changed

- The privacy notice is a Privacy tab now, opened from a shield in the title bar, instead of a page of its own.
- The About tab explains how to load the files that an open file needs, like a PDB file or a referenced assembly.

### Fixed

- A missing file gets the site's own page with the site's headers, not the host's page without them.
- Files with a fingerprint in their name get the Content Security Policy and the referrer policy too.
- The site shows its own logo as its icon, so browsers don't keep showing the host's icon.

## [1.0.0] - 2026-11-21

### Added

- An engine contract that every engine sits behind, so the site doesn't need code for each engine. It has the calls of an engine, its manifest, the layout of the rows and documents it sends and a queue that runs its calls in a worker with time and memory limits.
- A fake engine that reads tiny text files for the site's tests, with the conformance checks that every engine has to pass.
- A workbench page in the style of VS Code that opens files with the engines. Its Symbols view lists each file's symbols in a tree. A click on a row opens the symbol's document. Hover, Go to Definition, Outline, Find References and the symbol and string search work across the open files. An About tab shows how to use the site, its file formats and its keyboard shortcuts. Ctrl+K Ctrl+S opens the Keyboard Shortcuts editor to change them. Changed settings and keyboard shortcuts stay in the browser after a reload. A heart in the title bar opens a Support tab with the bank details that pay for the site's server.
- A Java engine that opens class files and archives with Vineflower and shows their classes as Java.
- A .NET engine that opens assemblies with ILSpy's decompiler and shows their types as C# and IL.
- A native engine that opens ELF, PE and Mach-O programs and libraries with Rizin and Ghidra's decompiler and shows their functions and classes as C. It also reads a PE file's PDB file for names and types and finds the classes of stripped files through their RTTI.
- A privacy notice about what stays in your browser and what the server keeps.

[Unreleased]: https://github.com/ero-qt/decomp.loter.dev/compare/1.2.1...HEAD
[1.2.1]: https://github.com/ero-qt/decomp.loter.dev/compare/1.2.0...1.2.1
[1.2.0]: https://github.com/ero-qt/decomp.loter.dev/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.4...1.1.0
[1.0.4]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.3...1.0.4
[1.0.3]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.2...1.0.3
[1.0.2]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.1...1.0.2
[1.0.1]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/ero-qt/decomp.loter.dev/releases/tag/1.0.0
