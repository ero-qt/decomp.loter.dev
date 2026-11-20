# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An engine contract that every engine sits behind, so the site doesn't need code for each engine. It has the calls of an engine, its manifest, the layout of the rows and documents it sends and a queue that runs its calls in a worker with time and memory limits.
- A fake engine that reads tiny text files for the site's tests, with the conformance checks that every engine has to pass.

[Unreleased]: https://github.com/ero-qt/decomp.loter.dev/commits/main/
