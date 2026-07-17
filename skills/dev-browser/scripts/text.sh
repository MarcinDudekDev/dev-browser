#!/bin/bash
# Fast path: text via server endpoint (no tsx, no connectOverCDP)
# Handles ARIA refs (e5) and CSS selectors — all server-side
target="${SCRIPT_ARGS}"
if [[ -z "$target" ]]; then
    echo 'Usage: text <ref|selector>' >&2
    exit 1
fi

PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"

body=$(jq -nc --arg target "$target" '{target: $target}')
result=$(curl -s -m 10 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/text" -H 'Content-Type: application/json' -d "$body")

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "text failed: $error" >&2
    exit 1
fi

# Output raw text like the tsx version
echo "$result" | jq -r '.text'
