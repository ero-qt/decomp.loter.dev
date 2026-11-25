# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A `<`, `<=` or `<<` in C# code has the color of an operator, not the red of a bracket without its pair.

## [1.4.0] - 2026-11-25

### Added

- Unity games built with IL2CPP open from their `global-metadata.dat`. The Symbols view lists every assembly's types and members by name. The search lists the strings of the game's metadata too. Pick the game's `GameAssembly.dll` or `libil2cpp.so` on the missing file's row to get each type as a C# stub with the types of its members. Until then, the stubs show `object` in place of each type, with a note on top about the missing file. The .NET engine's decompiler writes the stubs, so they look, color and link like the C# of a .NET assembly. Go to definition on a type in a stub opens that type, even in another assembly of the game. Games from the Unity 6000.5 alpha and the 6000.6 beta don't open. The site tells you that the engine can't read their metadata.
- The hover of a field shows its offset, and the hover of a method shows the addresses of its code on 1 line. A hover doesn't wait while the engine still writes the C of a type.
- When you open a type of a game with its binary, the native engine's decompiler turns the code of each of its methods into C#, which becomes the method's body in the stub. The stub shows up right away. Its methods' bodies fill in while the engine writes them. A method whose code the native engine can't decompile gets a comment in its body with the reason. Once the engine has the binary, it decompiles the methods of `Assembly-CSharp` and of the assembly of the type you open in the background, so a type you open later shows its bodies right away.
- The decompiler prints the bodies the way C# writes code. A field reads as `this.field`, a static field as `Class.field` and a call as `value.Method(arguments)` or `Class.Method(arguments)`, without IL2CPP's hidden last argument. A getter or a setter reads as its property, an operator as its sign, a base class's method as `base.Method()` and a new object with its constructor as `new Circle(1)`. Types have their C# names, like `int`, `bool` and `string`. A compiler's field keeps its real name, like `<Radius>k__BackingField`. The globals that IL2CPP fills with metadata read like `typeof(Circle)` or `Dictionary<string, int>.Add`. IL2CPP's checks that run static constructors and fill metadata don't show. A failed null check reads as `throw new NullReferenceException()`. Code that C# doesn't have a form for stays C. Each type, method or field that a body names links to its place in the game's stubs and shows its hover, so Go to definition on it opens its type's stub.
- Methods that share their code, like 2 getters that the linker folded into 1 function, show that code under a comment with links to the other methods. The body then reads the object by offsets, because the code doesn't belong to 1 class.
- A property with the compiler's backing field stays `{ get; set; }` in the stub. The Symbols view lists a property's accessors under the property.
- A method's body returns the value of the method's return type.
- The game lists the binary you pick as its file. Go to definition on a function of the binary in a body opens the function's C, even a function without a name, like `sub_18012712c`. A global of the binary, like `data_180974519`, opens with its bytes. The binary doesn't open a second time in the native engine.
- The native engine's C keeps each statement on 1 line, even a call with a long name.
- A game's `GameAssembly.dll` or `libil2cpp.so` in the native engine lists `script.json` and the game's `global-metadata.dat` as missing files. Pick a `script.json` from Il2CppDumper on its row and the tree and the C show the game's functions by name, like `Player$$Update`.
- When you pick the game's `global-metadata.dat` on its row under a `GameAssembly.dll` or `libil2cpp.so` in the native engine, the IL2CPP engine opens the game with the binary. The binary then closes in the native engine.
- The IL2CPP engine gives the decompiler the structs of the game's classes and the parameters of each method, so a body reads a field by its name. It also gives it the globals that the game fills with metadata, and a class's static fields, so a static method reads `Debug.s_Logger`.
- The native engine reads the lists `ScriptMetadata`, `ScriptMetadataMethod` and `ScriptString` of Il2CppDumper's `script.json`, so its C shows the globals that a game fills with metadata by name, like `UnityEngine.Debug_TypeInfo`.
- The native engine decompiles 32-bit ARM code, like the `libil2cpp.so` of an Android game, in ARM mode and in Thumb mode. It reads bit 0 of a method's address as the mark of Thumb code, like Unity sets it.
- Files you open together find each other now. If one of them is a missing file of another, like `GameAssembly.dll` or `libil2cpp.so` next to its `global-metadata.dat`, the site adds it to that file without a pick. You can also open them one after the other from the same folder, like the metadata after its `GameAssembly.dll`.

### Changed

- A symbol's hover shows its facts on 1 line under its declaration, with each value in code font, like `token 0x06000012`.
- The search for symbols and strings shows each file's results as soon as that file is searched, so a slow file doesn't hold back the others.

## [1.3.0] - 2026-11-25

### Added

- Ctrl+Shift+F and the search button of the Symbols view open a search for symbols and strings. `kind:method`, `is:public`, `is:static` and `in:Shapes.dll` filter the results by kind, by accessibility or modifier and by file, engine or assembly, also without a name. `Shape.Area` finds `Area` in `Shape`. A quote searches the strings, like `"hello`.
- The search also lists a string whose user the engine doesn't know.
- The Symbols view selects the row of the document in the editor, like after Go to definition into another type.

### Changed

- The C of a native function with many calls opens faster in a file with many symbols. A function with 5,000 calls in a file of 100,000 functions took 4 seconds to get ready and now takes a fraction of a second.
- The .NET engine keeps the symbols of an open assembly when another assembly opens or closes that it doesn't reference. Before, each open and close made the engine read the symbols of every open assembly again.
- Go to Symbol in Workspace answers each key faster in files with many symbols, because it keeps the list of names between the keys.
- Ctrl+Shift+F opens the new search. Before, it opened Go to Symbol in Workspace with a quote. Ctrl+T still opens Go to Symbol in Workspace.
- The About tab keeps the line with the source link and the version at its bottom. The rest of the page scrolls under it, also on a phone.
- The About, Privacy and Support tabs don't show a shadow at their top after you scroll.

### Fixed

- The host shows the first link or bad file of a release with thousands of them and removes the release. Before, the check stopped without a message and the release stayed on the host.
- The native engine lists a namespace whose name starts with `operator`, like `operators::add`, as a namespace with its functions. Before, the whole name showed up as 1 operator.
- The native engine keeps the whole name of a function whose parentheses aren't its parameters, like Go's `main.(*T).Method`. Before, the tree and the C cut such a name at its parenthesis.
- Find All References and the string search stop at once when you cancel them in a large native file. Before, the first search of a file's code ran in 1 step. A cancel that took longer than 2 seconds restarted the engine with every open native file.
- Find All References of a .NET type also finds the members whose code uses the type as a type argument, like `new List<Shape>()`, as the element of an array, as the type of a local or as the type of a caught exception.
- The C of an object file (`.o`) shows each global under its own name. Before, a global in `.bss` could show up as a string that sat at the same place. A few 32-bit x86 functions in object files decompile now too.
- The C of an object file calls each function by its own symbol. Before, the first function of a section could show up as `.text` or as an ARM marker like `$x`.

### Security

- The native engine runs on a newer Rizin, which fixes memory bugs that a broken or hostile file could hit. Rizin fixed a use-after-free in PE relocations, an out-of-bounds write when it reads length-prefixed strings, a bad free and a NULL pointer crash in PDB type records, a double free in DWARF data, a heap overflow in `rz_analysis_mask()` and undefined behavior in the ELF reader.

## [1.2.2] - 2026-11-23

### Added

- The About tab links the third-party notices, which the site serves as `third-party-notices.txt`.

### Changed

- The .NET engine runs on the final .NET 11 runtime (11.0.0). Building the site needs the .NET SDK 11.0.100 or a later 11.0 SDK.

### Fixed

- On a Mac, both Cmd+Backspace and the Delete key close the selected file in the Symbols view, like in VS Code's explorer.
- A collapsed file's row in the Symbols view clears the error of a picked companion file once a later pick works.
- A deploy job that I run again after the site switched to its release goes through. The host drops an upload with the same files as the live release and keeps the live balance.
- The .NET engine skips a type reference or a generic type that points back at itself in a broken file, so opening the C# of a type in that file can't crash the engine.
- The Java engine skips a class with a broken switch instruction and counts it with the classes it can't read, so that class can't freeze the engine.
- The native engine starts over after it crashes inside Rizin or Ghidra while it lists, decompiles or searches a file. Before, the next clicks could fail in odd ways until you reloaded the page.

### Security

- The readme's `gh attestation verify` command checks that the deploy workflow signed the checksums for the version's tag, so an attestation from another workflow or branch doesn't pass.
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

[Unreleased]: https://github.com/ero-qt/decomp.loter.dev/compare/1.4.0...HEAD
[1.4.0]: https://github.com/ero-qt/decomp.loter.dev/compare/1.3.0...1.4.0
[1.3.0]: https://github.com/ero-qt/decomp.loter.dev/compare/1.2.2...1.3.0
[1.2.2]: https://github.com/ero-qt/decomp.loter.dev/compare/1.2.1...1.2.2
[1.2.1]: https://github.com/ero-qt/decomp.loter.dev/compare/1.2.0...1.2.1
[1.2.0]: https://github.com/ero-qt/decomp.loter.dev/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.4...1.1.0
[1.0.4]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.3...1.0.4
[1.0.3]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.2...1.0.3
[1.0.2]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.1...1.0.2
[1.0.1]: https://github.com/ero-qt/decomp.loter.dev/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/ero-qt/decomp.loter.dev/releases/tag/1.0.0
