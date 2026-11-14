#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/sanitize-pg-env.sh
command -v timeout >/dev/null || { echo 'NOT RUN: GNU timeout required' >&2; exit 77; }
# Exact 0d62b7c diagnostic:407/407 PASS, wall948s; DIAGNOSTIC_NOT_ACCEPTANCE.
# ceil(948s * 1.15 / 30s) * 30s =1110s outer reserve; runner1140s.
# Observer snapshot repair fixes assertions, not the unexplained aggregate slowdown.
# Inner SQL/query/lock/idle limits, per-test30s, test list/concurrency and grace unchanged.
exec timeout --signal=TERM --kill-after=10s 1110s bash scripts/run-postgres-inner.sh
