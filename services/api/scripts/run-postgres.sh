#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/sanitize-pg-env.sh
command -v timeout >/dev/null || { echo 'NOT RUN: GNU timeout required' >&2; exit 77; }
# The scheduled mobile release test waits 61 seconds against an unchanged persisted instant.
# Measured 224-test diagnostic completed in 254408ms after the former 240s wrapper timed out.
# Only orchestration reserve increases; inner tests, concurrency, per-test bounds and kill grace are unchanged.
exec timeout --signal=TERM --kill-after=10s 300s bash scripts/run-postgres-inner.sh
