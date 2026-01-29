#!/bin/bash
# Fast path: goto via server endpoint (no tsx)
url="${SCRIPT_ARGS}"
if [[ -z "$url" ]]; then
    echo 'Usage: goto <url>' >&2
    exit 1
fi

PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"
CACHEBUST="${CACHEBUST:-0}"

cb="false"
[[ "$CACHEBUST" == "1" ]] && cb="true"

# Ensure page exists (POST /pages creates if missing)
curl -s -X POST "http://localhost:${PORT}/pages" -H 'Content-Type: application/json' -d "{\"name\":\"${PAGE_ID}\"}" >/dev/null

body=$(jq -nc --arg url "$url" --argjson cachebust "$cb" '{url: $url, cachebust: $cachebust}')
result=$(curl -s -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/goto" -H 'Content-Type: application/json' -d "$body")

status=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$status" ]]; then
    echo "$result" | jq . >&2
    exit 1
fi

echo "$result" | jq .
