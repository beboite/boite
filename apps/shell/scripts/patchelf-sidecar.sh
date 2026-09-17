#!/bin/sh
set -eu

# Rewriting the compiled Bun ARM64 ELF breaks its load segments. Its only
# dynamic dependencies are glibc, so it does not need the AppImage library path.
# Keep normal patchelf behavior for the shell, libraries and read-only queries.
if [ "$#" -eq 3 ] && [ "$1" = '--set-rpath' ]; then
  case "$3" in
    */usr/bin/boite-core)
      dependencies=$("${BOITE_PATCHELF:?}" --print-needed "$3")
      for library in $dependencies; do
        case "$library" in
          libc.so.6|libpthread.so.0|libdl.so.2|libm.so.6|librt.so.1) ;;
          *) echo "boite-core: unexpected dependency $library; review AppImage RPATH handling" >&2; exit 1 ;;
        esac
      done
      exit 0
      ;;
  esac
fi
exec "${BOITE_PATCHELF:?}" "$@"
