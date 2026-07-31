#!/usr/bin/env bash
# Public wrapper; the deny patterns themselves are private and never committed here.
# Fails closed: no pattern file (or a comment-only one) is an error, not a pass.
set -euo pipefail

BASE="${1:-origin/main}"
PATTERNS="${DEV_BROWSER_SANITIZE_PATTERNS:-$HOME/dev-browser-private/sanitize-deny.patterns}"

if [[ ! -f "$PATTERNS" ]]; then
  echo "SANITIZE GATE: missing pattern file: $PATTERNS (fail closed)" >&2
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
grep -vE '^[[:space:]]*(#|$)' "$PATTERNS" >"$tmp" || true
if [[ ! -s "$tmp" ]]; then
  echo "SANITIZE GATE: pattern file empty after stripping comments" >&2
  exit 1
fi

# Only ADDED lines matter. A deny pattern on a removed line means the range is
# deleting a client name, which is the point of the sanitize pass — grepping the
# whole diff would fail the gate for doing its job.
if git diff "$BASE"..HEAD | grep '^+' | grep -v '^+++' | grep -Eif "$tmp"; then
  echo "SANITIZE GATE FAILED" >&2
  exit 1
fi

echo "SANITIZE GATE OK"
