#!/usr/bin/env bash
# Builds the real mquickjs engine that Bruce runs (BruceDevices/mquickjs) into tools/.mqjs/ so the app tests can
# run on it. Needs git, gcc and make. Prints the path of the binary on success.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/.mqjs"
if [ ! -x "$dest/mqjs" ]; then
  mkdir -p "$dest"
  if [ ! -d "$dest/src" ]; then
    GIT_LFS_SKIP_SMUDGE=1 git clone -q --depth 1 https://github.com/BruceDevices/mquickjs "$dest/src"
  fi
  make -C "$dest/src" -j4 mqjs >/dev/null 2>&1
  cp "$dest/src/mqjs" "$dest/mqjs"
fi
echo "$dest/mqjs"
