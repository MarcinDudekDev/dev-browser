#!/bin/bash
# Fast path: wait for selector/text via server endpoint (no tsx, no connectOverCDP)
target="${SCRIPT_ARGS}"
if [[ -z "$target" ]]; then
    echo 'Usage: wait <selector|text>' >&2
    exit 1
fi

PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"

body=$(jq -nc --arg target "$target" '{target: $target}')
result=$(curl -s -m 35 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/wait" -H 'Content-Type: application/json' -d "$body")

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "wait failed: $error" >&2
    exit 1
fi

found=$(echo "$result" | jq -r '.found // empty')
echo "Found ${found}"
echo "URL: $(echo "$result" | jq -r '.url')"
exit 0
