#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p evidence
export npm_config_cache="$PWD/.npm-cache"
npm ci --ignore-scripts --registry=https://registry.npmjs.org --no-fund
npm run check 2>&1 | tee evidence/check.log
npm test 2>&1 | tee evidence/guard-test.log
bash scripts/audit.sh evidence/audit.json 2>&1 | tee evidence/audit-validation.log
# Missing PostgreSQL returns 77, never a green integration pass.
bash scripts/run-postgres.sh 2>&1 | tee evidence/postgres-test.log
