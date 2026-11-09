#!/usr/bin/env bash
# One end-to-end section against the running dev server (ng serve on 4200),
# without the production build, lint or unit tests. Usage: e2e/quick.sh quality
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node24/bin:$PATH"
SCRATCH="$(mktemp -d)" E2E_BASE='' E2E_ONLY="${1:?section: base or quality}" \
  node e2e/base-autolink.mjs "${2:-4200}"
