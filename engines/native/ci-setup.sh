#!/usr/bin/env bash
# installs clang, lld and LLVM's tools for the native fixture, which the shared claims test reads, and points
# NATIVE_LLVM at the newest LLVM folder that has them, like the test-native job
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
