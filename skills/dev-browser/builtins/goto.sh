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

# Ensure page exists (POST /pages creates if missing).
#
# This step OPENS A BROWSER TAB, so it is not a metadata write: on a freshly
# started server Chrome may still be coming up, and the first tab of a heavy
# profile has been measured at 2.8s warm. The old budget here was 5s with the
# result sent to /dev/null, which meant a slow creation failed INVISIBLY and
# the goto below then reported `Page "<name>" not found` — an error that names
# the registry instead of the timeout. Three sessions in one afternoon read
# that as a corrupt registry and went hunting for a phantom bug (msg#4764,
# #4767, #4769). Whatever this step costs, it must not lie about why it failed.
create_out=$(curl -s -m 45 -w '\n%{http_code}' -X POST "http://localhost:${PORT}/pages" \
    -H 'Content-Type: application/json' -d "{\"name\":\"${PAGE_ID}\"}" 2>&1)
create_code="${create_out##*$'\n'}"
create_body="${create_out%$'\n'*}"
if [[ "$create_code" != "200" ]]; then
    echo "goto failed: could not create page \"${PAGE_ID}\" on port ${PORT}" >&2
    if [[ -z "$create_code" || "$create_code" == "000" ]]; then
        echo "  the server did not answer within 45s (starting up, wedged, or the browser is gone)" >&2
        echo "  check: dev-browser.sh --status   then: dev-browser.sh --server" >&2
    else
        echo "  server said: HTTP ${create_code} ${create_body}" >&2
    fi
    exit 1
fi

body=$(jq -nc --arg url "$url" --argjson cachebust "$cb" '{url: $url, cachebust: $cachebust}')
result=$(curl -s -m 35 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/goto" -H 'Content-Type: application/json' -d "$body")

error=$(echo "$result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$error" ]]; then
    echo "goto failed: $error" >&2
    exit 1
fi

# Compact text output
echo "URL: $(echo "$result" | jq -r '.url')"
echo "Title: $(echo "$result" | jq -r '.title')"
state=$(echo "$result" | jq -r '.state // empty')
[[ -n "$state" ]] && echo "$state"
exit 0
