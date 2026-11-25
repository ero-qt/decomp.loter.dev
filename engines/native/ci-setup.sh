#!/usr/bin/env bash
# installs clang, lld and LLVM's tools for the native fixture, which the native tests and the shared claims test read,
# because Emscripten's LLVM only builds WebAssembly, and points NATIVE_LLVM at the newest LLVM folder that has them,
# because the runner has more than one
set -euo pipefail

sudo apt-get update
sudo apt-get install -y clang lld llvm

for folder in $(ls -d /usr/lib/llvm-*/bin | sort -rV); do
  if [ -x "$folder/clang++" ] && [ -x "$folder/ld.lld" ] && [ -x "$folder/llvm-lipo" ]; then
    echo "NATIVE_LLVM=$folder" >> "$GITHUB_ENV"
    exit 0
  fi
done

echo "No folder in /usr/lib has clang++, ld.lld and llvm-lipo." >&2
exit 1
