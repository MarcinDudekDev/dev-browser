#!/bin/bash
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
result=$(curl -s -m 10 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/keys" -H 'Content-Type: application/json' -d "$body")

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "keys failed: $error" >&2
    exit 1
fi

action=$(echo "$result" | jq -r '.action // "unknown"')
echo "Keys ${action}: ${keys}"
exit 0
