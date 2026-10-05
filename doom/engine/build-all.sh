#!/bin/sh
# Builds the engine for every platform the mod ships a binary for, into
# bin/<os>-<arch>/, with zig cc (https://ziglang.org) as the one cross compiler.
# Linux binaries are static (musl), so they run on any distribution.
set -eu
cd "$(dirname "$0")"
command -v zig >/dev/null || { echo "build-all.sh needs zig on PATH" >&2; exit 1; }
for pair in \
  linux-x86_64:x86_64-linux-musl \
  linux-arm64:aarch64-linux-musl \
  macos-x86_64:x86_64-macos \
  macos-arm64:aarch64-macos \
  windows-x86_64:x86_64-windows-gnu \
  windows-arm64:aarch64-windows-gnu; do
  name=${pair%%:*}
  target=${pair#*:}
  case $name in
  windows-*) out=bin/$name/doom-claude.exe libs="-lws2_32 -lwinmm" ;;
  *) out=bin/$name/doom-claude libs="-lm" ;;
  esac
  echo "== $name ($target)"
  rm -f "$out"
  make -s -j"$(nproc 2>/dev/null || echo 4)" CC="zig cc -target $target" OUT="$out" OBJDIR="build/$name" LIBS="$libs" LDFLAGS="-s"
done
# zig writes a .pdb beside each Windows binary; the binary does not need it.
rm -f bin/windows-*/*.pdb
ls -l bin/*/
