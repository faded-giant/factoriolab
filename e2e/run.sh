#!/usr/bin/env bash
# Offline checks for this fork: build, lint, unit tests and the base
# auto-link end-to-end test. Chrome runs with all non-local traffic blocked.
set -euo pipefail
cd "$(dirname "$0")/.."
export NG_CLI_ANALYTICS=false NO_UPDATE_NOTIFIER=1 npm_config_update_notifier=false
export CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}"

npx ng build --base-href /factoriolab/
npx ng lint
npx prettier --check .
# Upstream requires 100% coverage; only test failures should fail here
npx ng test --no-watch --progress=false --karma-config e2e/karma.offline.mjs 2>&1 \
  | tee /tmp/factoriolab-test.log | grep -E "TOTAL:" || true
grep -q "TOTAL: [0-9]* SUCCESS" /tmp/factoriolab-test.log

python3 -I e2e/spa_server.py dist/factoriolab/browser 8799 &
server=$!
trap 'kill $server' EXIT
sleep 1
SCRATCH="$(mktemp -d)" node e2e/base-autolink.mjs 8799
