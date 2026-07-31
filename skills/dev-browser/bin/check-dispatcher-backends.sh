#!/usr/bin/env bash
# skills/dev-browser/bin/check-dispatcher-backends.sh
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
DB="$ROOT/skills/dev-browser"
WRAPPER="$DB/dev-browser.sh"

if [[ -d "$DB/builtins" ]]; then
  BDIR_REL="skills/dev-browser/builtins"
elif [[ -d "$DB/scripts" ]]; then
  BDIR_REL="skills/dev-browser/scripts"
else
  echo "No builtins/ or scripts/ directory" >&2
  exit 1
fi

arm=""
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == *'goto|'* && "$line" == *'click|'* && "$line" == *'fill|'* && "$line" == *')'* ]]; then
    arm=$line
    break
  fi
done < "$WRAPPER"

if [[ -z "$arm" ]]; then
  echo "dispatcher: could not find case arm with goto|click|…fill|…)" >&2
  exit 1
fi

list=${arm#*goto}
list="goto${list%%)*}"
list=${list//|/ }

n=0
for _verb in $list; do
  n=$((n + 1))
done
if [[ "$n" -lt 15 ]]; then
  echo "dispatcher: parsed only $n verbs (expected ~20); parse failed or arm changed" >&2
  echo "  arm line was: $arm" >&2
  exit 1
fi

fail=0
for verb in $list; do
  path="$BDIR_REL/${verb}.ts"
  if ! git -C "$ROOT" ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "DISPATCHER VERB WITHOUT TRACKED .ts: $verb (expected $path)" >&2
    fail=1
  fi
done

exit "$fail"
