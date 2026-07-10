#!/bin/sh
set -eu

desktop_codex_dir="/Applications/ChatGPT.app/Contents/Resources"
if [ -x "$desktop_codex_dir/codex" ]; then
  PATH="$desktop_codex_dir:$PATH"
  export PATH
fi

exec npx --yes goalbuddy@0.4.0 "$@"
