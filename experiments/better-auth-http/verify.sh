#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .test-home evidence
export HOME="$PWD/.test-home"
export npm_config_cache="$PWD/.npm-cache"
export EXPO_NO_TELEMETRY=1 CI=1
npm ci --ignore-scripts --registry=https://registry.npmjs.org --no-fund
npm run check 2>&1 | tee evidence/check.log
npm test 2>&1 | tee evidence/test.log
bash scripts/audit.sh evidence/audit.json 2>&1 | tee evidence/audit-validation.log
