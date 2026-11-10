#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  echo 'Usage: audit.sh output-json-path' >&2
  exit 2
fi
script_dir="$(cd "$(dirname "$0")" && pwd)"
# Exit 1 can mean vulnerability findings OR an operational npm error.
# Never classify an exit code alone as a completed audit.
status=0
npm audit --json > "$1" || status=$?
node "$script_dir/validate-audit.mjs" "$1" "$status"
