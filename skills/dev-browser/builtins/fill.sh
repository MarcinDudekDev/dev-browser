#!/bin/bash
# Fast path: fill via server endpoint (no tsx)
# Supports:
#   fill field value             — single field by name
#   fill field=value             — single field, legacy format
#   fill "field1=val1 field2=val2"  — multi-field (spaces in values OK)
#   fill '{"field":"value",...}'    — JSON object (handles any value)
args="${SCRIPT_ARGS}"
if [[ -z "$args" ]]; then
    echo 'Usage: fill <field> <value> | fill "field1=val1 field2=val2" | fill '\''{"f":"v"}'\''' >&2
    exit 1
fi

PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"
PORT="${SERVER_PORT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Helper: fill one field via server API
fill_one() {
    local target="$1" value="$2"
    local body
    body=$(jq -nc --arg target "$target" --arg value "$value" '{target: $target, value: $value}')
    curl -s -m 10 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/fill" \
        -H 'Content-Type: application/json' -d "$body"
}

# JSON mode: fill '{"email":"test@x.com","password":"P@ss=w0rd"}'
if [[ "$args" == \{* ]]; then
    filled=()
    failed=()
    last_result=""

    # Iterate JSON keys
    for target in $(echo "$args" | jq -r 'keys[]' 2>/dev/null); do
        value=$(echo "$args" | jq -r --arg k "$target" '.[$k]')
        last_result=$(fill_one "$target" "$value")
        error=$(echo "$last_result" | jq -r '.error // empty' 2>/dev/null)
        if [[ -n "$error" ]]; then
            failed+=("$target")
        else
            filled+=("$target")
        fi
    done

    [[ ${#filled[@]} -gt 0 ]] && echo "Filled: $(IFS=', '; echo "${filled[*]}")"
    [[ ${#failed[@]} -gt 0 ]] && echo "Not found: $(IFS=', '; echo "${failed[*]}")" >&2
    if [[ -n "$last_result" ]]; then
        state=$(echo "$last_result" | jq -r '.state // empty')
        [[ -n "$state" ]] && echo "$state"
    fi
    [[ ${#failed[@]} -gt 0 ]] && exit 1
    exit 0
fi

# Multi-field mode: parse key=value pairs using external perl script
kv_data=$(perl "$SCRIPT_DIR/parse-kv.pl" "$args")
kv_count=$(echo -n "$kv_data" | grep -c . || true)

if [[ $kv_count -ge 2 ]]; then
    filled=()
    failed=()
    last_result=""

    while IFS=$'\t' read -r target value; do
        [[ -z "$target" ]] && continue
        last_result=$(fill_one "$target" "$value")
        error=$(echo "$last_result" | jq -r '.error // empty' 2>/dev/null)
        if [[ -n "$error" ]]; then
            failed+=("$target")
        else
            filled+=("$target")
        fi
    done <<< "$kv_data"

    [[ ${#filled[@]} -gt 0 ]] && echo "Filled: $(IFS=', '; echo "${filled[*]}")"
    [[ ${#failed[@]} -gt 0 ]] && echo "Not found: $(IFS=', '; echo "${failed[*]}")" >&2
    if [[ -n "$last_result" ]]; then
        state=$(echo "$last_result" | jq -r '.state // empty')
        [[ -n "$state" ]] && echo "$state"
    fi
    [[ ${#failed[@]} -gt 0 ]] && exit 1
    exit 0
fi

# Single field mode
if [[ "${SCRIPT_ARGC:-0}" -ge 2 && -n "${SCRIPT_ARG0:-}" && -n "${SCRIPT_ARG1:-}" ]]; then
    # Use individually-exported args (preserves compound selectors with spaces)
    target="$SCRIPT_ARG0"
    value="$SCRIPT_ARG1"
elif [[ "$args" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*= ]]; then
    target="${args%%=*}"
    value="${args#*=}"
else
    target="${args%% *}"
    value="${args#* }"
    [[ "$target" == "$value" ]] && { echo 'Usage: fill <field> <value>' >&2; exit 1; }
fi

# ARIA refs handled server-side (no tsx/connectOverCDP needed)

result=$(fill_one "$target" "$value")
error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "fill failed ($target): $error" >&2
    exit 1
fi

echo "Filled: $target"
state=$(echo "$result" | jq -r '.state // empty')
[[ -n "$state" ]] && echo "$state"
