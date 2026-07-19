#!/usr/bin/env bash
#
# check-no-meili-key-in-web.sh — guards the private-Meili boundary at the browser
# tier. The SPA must talk ONLY to the API (`VITE_API_URL`); it must never carry a
# Meilisearch key or host. This inspects the BUILT bundle — the actual artifact
# shipped to users — so a stray import/env leak is caught in CI.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

DIST="packages/web/dist"

# Rebuild fresh so the inspected bundle always reflects current source (a stale
# dist could hide a newly-introduced leak).
echo "ℹ️  check-no-meili-key-in-web: building the SPA bundle to inspect…"
npm run -w packages/web build >/dev/null 2>&1

if [ ! -d "$DIST" ] || [ -z "$(ls -A "$DIST" 2>/dev/null)" ]; then
  echo "❌ check-no-meili-key-in-web: expected a built bundle at ${DIST} but found none." >&2
  exit 1
fi

# Forbidden tokens that must NEVER reach the browser:
#   - any MEILI_ env-var name (MEILI_MASTER_KEY, MEILI_HOST, …)
#   - a Meili service host reference (meili:7700 / //meili)
PATTERN='MEILI_|meili:7700|//meili'

if grep -rIEl "$PATTERN" "$DIST" >/dev/null 2>&1; then
  echo "❌ check-no-meili-key-in-web: a Meili key/host token appears in the built SPA bundle:" >&2
  grep -rInE "$PATTERN" "$DIST" >&2 || true
  echo >&2
  echo "The browser must never carry a Meili key or host — it talks only to the API." >&2
  exit 1
fi

echo "✅ check-no-meili-key-in-web: no MEILI_ key or Meili host in the built SPA bundle."
