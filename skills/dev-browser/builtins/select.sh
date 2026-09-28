#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../lib/fastpath.sh"
# Fast path: select via server endpoint (no tsx)
args="${SCRIPT_ARGS}"
if [[ -z "$args" ]]; then
    echo 'Usage: select <field> <value>' >&2
    exit 1
fi

target="${args%% *}"
value="${args#* }"
[[ "$target" == "$value" ]] && { echo 'Usage: select <field> <value>' >&2; exit 1; }

# ARIA refs handled server-side (no tsx/connectOverCDP needed)

PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"

body=$(jq -nc --arg target "$target" --arg value "$value" '{target: $target, value: $value}')
result=$(fp_post "/pages/${PAGE_ID}/select" "$body" 10) || exit 1

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "select failed: $error" >&2
    exit 1
fi

echo "$result" | jq .
