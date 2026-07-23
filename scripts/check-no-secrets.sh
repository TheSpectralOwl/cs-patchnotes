#!/usr/bin/env bash
#
# Guards against committed secret values.
#
# Fails if any tracked, non-`.example` file assigns a REAL value to a known
# secret variable. The committed `.env.example` carries names with empty values
# only; compose files reference secrets via `${VAR}` interpolation (never a
# literal). This gate turns "no leaked secret in the repo" into an exit code
# that CI can reuse.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Known secret variable names that must never carry a literal value in-repo.
SECRET_VARS='TUNNEL_TOKEN|RELOAD_TOKEN|CONTENT_REPO_TOKEN'

# Match an ASSIGNMENT of a secret var to a literal value:
#   <ws>(export )?["']?SECRET["']? <ws> (:|=) <ws> <first value char>
# The var must be the key at line start (so an inner `${RELOAD_TOKEN:?err}`
# interpolation never trips), and the first value
# char must not be whitespace, `$` (a `${VAR}` reference), or `#` (a comment).
# A quoted environment expansion is also safe, such as `RELOAD_TOKEN="$RELOAD_TOKEN"`.
PATTERN="^[[:space:]]*(export[[:space:]]+)?['\"]?(${SECRET_VARS})['\"]?[[:space:]]*[:=][[:space:]]*(?!['\"]?\\$)[^[:space:]\\$#]"

# Search tracked files only; exclude the *.example name-contract and planning docs.
if leaks="$(git grep -nP "$PATTERN" -- ':!*.example' ':!.planning/')"; then
  echo "❌ check-no-secrets: a tracked file assigns a real value to a secret variable:" >&2
  printf '%s\n' "$leaks" >&2
  echo >&2
  echo "Secrets must live only in a git-ignored .env / CI secrets — never committed." >&2
  exit 1
fi

echo "✅ check-no-secrets: no committed secret values found in tracked files."
