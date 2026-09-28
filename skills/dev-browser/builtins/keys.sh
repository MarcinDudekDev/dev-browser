#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/../lib/fastpath.sh"
# Fast path: keyboard input via server endpoint (no tsx, no connectOverCDP)
# Handles text typing and special key presses — all server-side
keys="${SCRIPT_ARGS}"
if [[ -z "$keys" ]]; then
    echo 'Usage: keys <text|key>' >&2
    exit 1
fi

PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"

body=$(jq -nc --arg keys "$keys" '{keys: $keys}')
result=$(fp_post "/pages/${PAGE_ID}/keys" "$body" 10) || exit 1

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "keys failed: $error" >&2
    exit 1
fi

action=$(echo "$result" | jq -r '.action // "unknown"')
echo "Keys ${action}: ${keys}"
exit 0
