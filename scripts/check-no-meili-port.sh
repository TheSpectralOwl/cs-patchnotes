#!/usr/bin/env bash
#
# check-no-meili-port.sh — OPS-01 guard (T-00-09, Pitfall 1).
#
# Fails if the BASE compose file publishes a host port for the `meili` service.
# Meilisearch must stay private, reached only by service name over the internal
# network. Local loopback debug binds live in docker-compose.override.yml and are
# intentionally NOT considered here — we pass `-f docker-compose.yml` explicitly
# so the override is never auto-merged (matches the VPS deploy invocation).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

COMPOSE_FILE="docker-compose.yml"

# Isolate the `meili:` service block (2-space-indented service header) from a
# YAML stream, stopping at the next service header or any top-level key.
meili_block() {
  awk '
    /^[^[:space:]]/                        { inblk = 0 }                       # top-level key ends the block
    /^  [a-zA-Z0-9_-]+:[[:space:]]*$/      { inblk = ($0 ~ /^  meili:[[:space:]]*$/) }
    inblk                                  { print }
  '
}

# Preferred path: render the fully-resolved config and look for a published host
# port under meili. `docker compose config` normalizes `ports:` into mappings
# carrying a `published:` field whenever a host port is bound. Dummy secret env
# vars satisfy the `${VAR:?...}` interpolations so config can render.
if command -v docker >/dev/null 2>&1 \
  && config="$(MEILI_MASTER_KEY=x TUNNEL_TOKEN=x ANTHROPIC_API_KEY=x \
       docker compose -f "$COMPOSE_FILE" config 2>/dev/null)"; then
  block="$(printf '%s\n' "$config" | meili_block)"
  if printf '%s\n' "$block" | grep -qE '(^|[[:space:]])published:'; then
    echo "❌ check-no-meili-port: meili publishes a host port in ${COMPOSE_FILE}:" >&2
    printf '%s\n' "$block" | grep -nE 'ports:|published:|target:' >&2
    exit 1
  fi
  echo "✅ check-no-meili-port: meili has no published host port (docker compose config)."
  exit 0
fi

# Fallback (no docker CLI / config could not render): assert the source compose
# file's meili block contains no `ports:` key at all.
block="$(meili_block < "$COMPOSE_FILE")"
if printf '%s\n' "$block" | grep -qE '^[[:space:]]*ports:'; then
  echo "❌ check-no-meili-port: meili service defines a ports: mapping in ${COMPOSE_FILE}:" >&2
  printf '%s\n' "$block" | grep -nE 'ports:' >&2
  exit 1
fi
echo "✅ check-no-meili-port: meili has no ports: mapping (source fallback; docker CLI unavailable)."
