# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An engine contract that every engine sits behind, so the site doesn't need code for each engine. It has the calls of an engine, its manifest, the layout of the rows and documents it sends and a queue that runs its calls in a worker with time and memory limits.
- A fake engine that reads tiny text files for the site's tests, with the conformance checks that every engine has to pass.
- A workbench page in the style of VS Code that opens files with the engines. Its Symbols view lists each file's symbols in a tree. A click on a row opens the symbol's document. Hover, Go to Definition, Outline, Find References and the symbol and string search work across the open files. An About tab shows how to use the site, its file formats and its keyboard shortcuts. Ctrl+K Ctrl+S opens the Keyboard Shortcuts editor to change them. Changed settings and keyboard shortcuts stay in the browser after a reload. A heart in the title bar opens a Support tab with the bank details that pay for the site's server.

[Unreleased]: https://github.com/ero-qt/decomp.loter.dev/commits/main/
