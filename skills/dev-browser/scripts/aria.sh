#!/bin/bash
# Fast path: ARIA snapshot via server endpoint (no tsx/CDP reconnection)
PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"

result=$(curl -s -m 35 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/aria" -H 'Content-Type: application/json' -d '{}')

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "ARIA snapshot failed: $error" >&2
    exit 1
fi

snapshot=$(echo "$result" | jq -r '.snapshot // empty' 2>/dev/null)
if [[ -z "$snapshot" ]]; then
    echo "Could not get ARIA snapshot. Navigate first: goto <url>" >&2
    exit 1
fi

echo "$snapshot"
