#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .test-home evidence
export HOME="$PWD/.test-home"
export npm_config_cache="$PWD/.npm-cache"
export EXPO_NO_TELEMETRY=1 CI=1
npm ci --ignore-scripts --registry=https://registry.npmjs.org --no-fund
npm test 2>&1 | tee evidence/test.log
npm run typecheck 2>&1 | tee evidence/typecheck.log
npm run export 2>&1 | tee evidence/export.log
# Findings are recorded, while operational/parse failures fail verification.
bash scripts/audit.sh evidence/audit.json
