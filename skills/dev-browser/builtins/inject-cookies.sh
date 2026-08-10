#!/bin/bash
# Fast path: inject cookies from Cookie Bridge into dev-browser's Playwright context
# Usage: dev-browser.sh inject-cookies <domain> [cookie-bridge-port]
# Fetches cookies from Cookie Bridge /cookies endpoint, injects via Playwright addCookies(),
# then reloads the current page so the SPA picks up the session.

domain="${SCRIPT_ARG0}"
cb_port="${SCRIPT_ARG1:-9999}"
PORT="${SERVER_PORT}"
PREFIX="${PROJECT_PREFIX:-dev}"
PAGE="${PAGE_NAME:-main}"
PAGE_ID="${PREFIX}-${PAGE}"

if [[ -z "$domain" ]]; then
    echo "Usage: dev-browser.sh inject-cookies <domain> [cookie-bridge-port]" >&2
    echo "  Fetches cookies from Cookie Bridge and injects into browser context." >&2
    echo "  Example: dev-browser.sh inject-cookies indietools.app" >&2
    exit 1
fi

# Shared Cookie Bridge preflight + loud-failure helpers (see lib/cookie-bridge.sh
# for why a quiet failure here is never acceptable).
_CB_LIB="${DEV_BROWSER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/lib/cookie-bridge.sh"
if [[ ! -f "$_CB_LIB" ]]; then
    echo "ERROR: missing $_CB_LIB — dev-browser install is incomplete." >&2
    exit 1
fi
# shellcheck source=../lib/cookie-bridge.sh
source "$_CB_LIB"

# 1. Fetch cookies from Cookie Bridge (token-gated; token is local 0600 file)
cb_load_token "$domain" "$cb_port"

cb_get "$cb_port" "/cookies?domain=${domain}&agent_id=${CB_AGENT_ID}"
if [[ "$CB_HTTP_CODE" != "200" ]]; then
    cb_die_from_response "$domain" "$cb_port" "cookies" "$CB_HTTP_CODE" "$CB_BODY"
fi
cb_result="$CB_BODY"

cookie_count=$(printf '%s' "$cb_result" | jq -r '.count // 0' 2>/dev/null)
if [[ "$cookie_count" == "0" ]]; then
    cb_assert_payload "$domain" "$cb_port" 0 0 0
fi

# 2. Extract just the cookies array and inject into dev-browser
cookies_json=$(printf '%s' "$cb_result" | jq -c '.cookies // []' 2>/dev/null)
cb_assert_cookies_alive "$domain" "$cb_port" "$cookies_json"

inject_result=$(curl -s -m 10 -X POST "http://localhost:${PORT}/cookies" \
    -H "Content-Type: application/json" \
    -d "{\"cookies\":${cookies_json}}")

inject_error=$(echo "$inject_result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$inject_error" ]]; then
    echo "inject-cookies failed: $inject_error" >&2
    exit 1
fi

echo "Injected ${cookie_count} cookies for ${domain}"

# 3. Reload the page so the SPA picks up the session cookies
reload_result=$(curl -s -m 10 -X POST "http://localhost:${PORT}/pages/${PAGE_ID}/evaluate" \
    -H "Content-Type: application/json" \
    -d '{"code":"location.reload()"}')

echo "Page reloaded — check if auth session is active"

cb_warn_if_expiring "$domain" "$cb_port"
