#!/bin/bash
# Fast path: click via server endpoint (no tsx, no connectOverCDP)
# Handles text, ARIA refs (e5), and CSS selectors — all server-side
target="${SCRIPT_ARGS}"
if [[ -z "$target" ]]; then
    echo 'Usage: click <text|ref|selector>' >&2
    exit 1
fi

PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"

# Build JSON body, include force flag if set
if [[ "${FORCE_CLICK:-0}" == "1" ]]; then
    body=$(jq -nc --arg target "$target" '{target: $target, force: true}')
else
    body=$(jq -nc --arg target "$target" '{target: $target}')
fi
result=$(curl -s -m 10 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/click" -H 'Content-Type: application/json' -d "$body")

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "click failed: $error" >&2
    exit 1
fi

# Compact text output
clickType=$(echo "$result" | jq -r '.type // "element"')
echo "Clicked ${clickType}: ${target}"
echo "URL: $(echo "$result" | jq -r '.url')"
echo "Title: $(echo "$result" | jq -r '.title // empty')"
state=$(echo "$result" | jq -r '.state // empty')
[[ -n "$state" ]] && echo "$state"
exit 0
