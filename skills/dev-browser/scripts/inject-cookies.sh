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

# 1. Fetch cookies from Cookie Bridge
cb_result=$(curl -s -m 10 "http://127.0.0.1:${cb_port}/cookies?domain=${domain}&agent_id=dev-browser")
cb_error=$(echo "$cb_result" | jq -r '.error // empty' 2>/dev/null)
if [[ -n "$cb_error" ]]; then
    echo "Cookie Bridge error: $cb_error" >&2
    echo "Make sure Cookie Bridge is running and has an approved session for ${domain}" >&2
    exit 1
fi

cookie_count=$(echo "$cb_result" | jq -r '.count // 0' 2>/dev/null)
if [[ "$cookie_count" == "0" ]]; then
    echo "No cookies found for ${domain}" >&2
    exit 1
fi

# 2. Extract just the cookies array and inject into dev-browser
cookies_json=$(echo "$cb_result" | jq -c '.cookies' 2>/dev/null)

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
