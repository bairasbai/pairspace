#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/sanitize-pg-env.sh
command -v timeout >/dev/null || { echo 'NOT RUN: GNU timeout required' >&2; exit 77; }
# The scheduled mobile release test waits 61 seconds against an unchanged persisted instant.
# Allow the full synthetic suite and cluster startup while retaining per-test bounds.
exec timeout --signal=TERM --kill-after=10s 180s bash scripts/run-postgres-inner.sh
