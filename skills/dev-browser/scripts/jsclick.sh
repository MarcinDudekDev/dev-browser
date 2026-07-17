#!/bin/bash
# Fast path: JS click via server endpoint (no tsx, no connectOverCDP)
# Dispatches mousedown/mouseup/click + node.click() for maximum JS handler compat
target="${SCRIPT_ARGS}"
if [[ -z "$target" ]]; then
    echo 'Usage: jsclick <text|ref|selector>' >&2
    exit 1
fi

PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"

body=$(jq -nc --arg target "$target" '{target: $target}')
result=$(curl -s -m 10 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/jsclick" -H 'Content-Type: application/json' -d "$body")

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "jsclick failed: $error" >&2
    exit 1
fi

clickType=$(echo "$result" | jq -r '.type // "element"')
echo "JS-Clicked ${clickType}: ${target}"
echo "URL: $(echo "$result" | jq -r '.url')"
exit 0
