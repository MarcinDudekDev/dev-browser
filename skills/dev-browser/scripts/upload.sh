#!/bin/bash
# Fast path: upload file via server endpoint (no tsx, no connectOverCDP)
# Handles CSS selectors, ARIA refs (e5), and name attributes — all server-side
args="${SCRIPT_ARGS}"
if [[ -z "$args" ]]; then
    echo 'Usage: upload <selector|ref|name> <filepath>' >&2
    exit 1
fi

# Parse: first token = selector/ref, rest = file path
target="${args%% *}"
filepath="${args#* }"
if [[ "$target" == "$filepath" || -z "$filepath" ]]; then
    echo 'Usage: upload <selector|ref|name> <filepath>' >&2
    exit 1
fi

if [[ ! -f "$filepath" ]]; then
    echo "File not found: $filepath" >&2
    exit 1
fi

PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"

body=$(jq -nc --arg target "$target" --arg filepath "$filepath" '{target: $target, filepath: $filepath}')
result=$(curl -s -m 30 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/upload" -H 'Content-Type: application/json' -d "$body")

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "upload failed: $error" >&2
    exit 1
fi

uploaded=$(echo "$result" | jq -r '.uploaded // empty')
type=$(echo "$result" | jq -r '.type // "unknown"')
echo "Uploaded: ${uploaded} (matched via ${type})"
exit 0
