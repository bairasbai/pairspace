#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/sanitize-pg-env.sh
command -v timeout >/dev/null || { echo 'NOT RUN: GNU timeout required' >&2; exit 77; }
exec timeout --signal=TERM --kill-after=10s 60s bash scripts/run-postgres-inner.sh
