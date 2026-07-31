#!/bin/bash
# Diagnostic commands: debug, crashes, tabs, cleanup

cmd_debug() {
    echo "=== RECENT DEBUG LOG (last 50 lines) ==="
    tail -50 "$DEBUG_LOG" 2>/dev/null || echo "(no debug log yet)"
}

cmd_crashes() {
    local mode="${BROWSER_MODE:-$(get_current_mode)}"
    echo "=== CRASH LOG (mode: $mode) ==="
    if [[ -f "$SKILL_TMP_DIR/crash-${mode}.log" ]]; then
        tail -100 "$SKILL_TMP_DIR/crash-${mode}.log"
    else
        echo "(no crashes recorded)"
    fi
    echo ""
    echo "=== LAST SESSION INFO ==="
    if [[ -f "$SKILL_TMP_DIR/sessions-${mode}.json" ]]; then
        cat "$SKILL_TMP_DIR/sessions-${mode}.json"
    else
        echo "(no session info)"
    fi
}

cmd_tabs() {
    # Find running server by checking all mode ports
    # An explicitly requested mode wins over the scan order, so `--stealth --tabs`
    # reports stealth even when a dev server is also up (same fix as cmd_cleanup).
    local _cdp="" _http=""
    if [[ -n "$BROWSER_MODE" ]]; then
        local _want=($(get_mode_ports "$BROWSER_MODE"))
        if curl -s --connect-timeout 1 "http://localhost:${_want[0]}/health" 2>/dev/null | grep -q ok; then
            _http="${_want[0]}"; _cdp="${_want[1]}"
        fi
    fi
    for _mode in dev stealth user; do
        [[ -n "$_cdp" ]] && break
        local _ports=($(get_mode_ports "$_mode"))
        if curl -s --connect-timeout 1 "http://localhost:${_ports[0]}/health" 2>/dev/null | grep -q ok; then
            _http="${_ports[0]}"; _cdp="${_ports[1]}"; break
        fi
    done
    [[ -z "$_cdp" ]] && _cdp="$CDP_PORT"
    [[ -z "$_http" ]] && _http="$SERVER_PORT"

    echo "=== CHROME TABS (via CDP port $_cdp) ==="
    curl -s -m 10 "http://localhost:$_cdp/json/list" 2>/dev/null | python3 -c "
import sys, json
try:
    tabs = json.load(sys.stdin)
except:
    print('(server not running or CDP unavailable)')
    sys.exit(0)

blank = [t for t in tabs if t.get('url','').startswith('about:')]
stripe = [t for t in tabs if 'stripe' in t.get('url','').lower()]
other = [t for t in tabs if not t.get('url','').startswith('about:') and 'stripe' not in t.get('url','').lower()]

print(f'Total: {len(tabs)} tabs')
print()
if other:
    print(f'Pages ({len(other)}):')
    for t in other:
        print(f'  {t.get(\"url\",\"?\")[:70]}')
if stripe:
    print(f'Stripe iframes ({len(stripe)}): (created by payment forms)')
if blank:
    print(f'about:blank ({len(blank)}): (orphaned, safe to close)')
"
    echo ""
    echo "=== REGISTERED PAGES ==="
    curl -s -m 10 "http://localhost:$_http/pages" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); pages=d.get('pages',[]); print(f'{len(pages)} registered'); [print(f'  - {p}') for p in pages]" 2>/dev/null || echo "(server not running)"
}

cmd_cleanup() {
    # Usage: --cleanup [--all | --project <prefix> | --unregistered]
    # Default (no args): close about:blank tabs only
    # --all: close ALL unregistered tabs (keeps only registry pages)
    # --project <prefix>: close registry page for a specific project (e.g. tools, marketing)
    # --unregistered: close all tabs not in registry
    local mode="${1:-blank}"
    local project_prefix="$2"

    # --mine: close only THIS session's pages (alias for --project <my-prefix>).
    # This is the correct end-of-session cleanup — never touches other sessions.
    if [[ "$mode" == "--mine" ]]; then
        mode="--project"
        project_prefix=$(get_project_prefix)
        echo "Cleaning up pages for project '$project_prefix' only" >&2
    fi

    # Find running server. An explicitly requested mode (--stealth/--user flag or
    # exported BROWSER_MODE) wins over the scan order, so `--stealth --cleanup`
    # reaps stealth even when a dev server is also up.
    local _found_mode=""
    if [[ -n "$BROWSER_MODE" ]]; then
        local _want=($(get_mode_ports "$BROWSER_MODE"))
        if curl -s --connect-timeout 1 "http://localhost:${_want[0]}/health" 2>/dev/null | grep -q ok; then
            SERVER_PORT="${_want[0]}"; CDP_PORT="${_want[1]}"; _found_mode="$BROWSER_MODE"
        fi
    fi
    for _mode in dev stealth user; do
        [[ -n "$_found_mode" ]] && break
        local _ports=($(get_mode_ports "$_mode"))
        if curl -s --connect-timeout 1 "http://localhost:${_ports[0]}/health" 2>/dev/null | grep -q ok; then
            SERVER_PORT="${_ports[0]}"; CDP_PORT="${_ports[1]}"; _found_mode="$_mode"; break
        fi
    done

    # HARD GUARD: in user mode CDP_PORT is the user's REAL Brave. Bulk-closing
    # "unregistered"/about:blank tabs would wipe the user's live windows. Only
    # --project (closes a single page WE registered) is permitted in user mode.
    if [[ "$_found_mode" == "user" && "$mode" != "--project" ]]; then
        echo "REFUSED: '--cleanup $mode' is disabled in user mode — it would close the user's real Brave tabs." >&2
        echo "User mode only ever closes tabs dev-browser itself created. Use '--cleanup --project <prefix>' to close a specific registered page." >&2
        return 1
    fi

    # Get registered pages from server
    local registry_json
    registry_json=$(curl -s -m 10 "http://localhost:$SERVER_PORT/pages" 2>/dev/null)

    curl -s -m 10 "http://localhost:$CDP_PORT/json/list" 2>/dev/null | python3 -c "
import sys, json, urllib.request

mode = '$mode'
project_prefix = '$project_prefix'
cdp_port = '$CDP_PORT'
server_port = '$SERVER_PORT'

try:
    tabs = json.load(sys.stdin)
except:
    print('Server not running')
    sys.exit(1)

# Get registered page names
try:
    registry = json.loads('$registry_json')
    registered = set(registry.get('pages', []))
except:
    registered = set()

# Get target IDs for registered pages (to protect them)
targets = registry.get('targets', {}) if isinstance(registry, dict) else {}
registered_targets = set(targets.values())

print(f'Total: {len(tabs)} tabs, {len(registered)} registered pages')
print(f'Registered: {sorted(registered)}')
if registered_targets:
    print(f'Protected target IDs: {len(registered_targets)}')
print()

to_close = []

if mode == 'blank':
    # Registered pages are protected even when parked on about:blank — a page
    # created but not yet navigated is a live session's page, not an orphan.
    to_close = [t for t in tabs
                if t.get('url','').startswith('about:blank')
                and t.get('id','') not in registered_targets]
    print(f'Mode: close orphaned about:blank tabs ({len(to_close)} found)')

elif mode == '--all' or mode == '--unregistered':
    # Close tabs whose CDP target ID is NOT in the registry
    for t in tabs:
        tid = t.get('id', '')
        if tid in registered_targets:
            continue  # protected — belongs to a registered page
        to_close.append(t)
    print(f'Mode: close unregistered tabs ({len(to_close)} found, keeping {len(registered_targets)} registered)')

elif mode == '--project':
    if not project_prefix:
        print('Usage: --cleanup --project <prefix>')
        print('Example: --cleanup --project tools')
        sys.exit(1)
    # Close ALL registry pages for this project via DELETE API
    # (a session can have several: prefix-main, prefix-admin, ...)
    mine = sorted(p for p in registered if p == project_prefix or p.startswith(project_prefix + '-'))
    if not mine:
        print(f'No registered pages found for prefix \"{project_prefix}\"')
        print(f'Registered: {sorted(registered)}')
        sys.exit(0)
    import urllib.parse
    for page_name in mine:
        try:
            encoded = urllib.parse.quote(page_name)
            req = urllib.request.Request(f'http://localhost:{server_port}/pages/{encoded}', method='DELETE')
            urllib.request.urlopen(req, timeout=5)
            print(f'Closed registered page: {page_name}')
        except Exception as e:
            print(f'Failed to close {page_name}: {e}')
    sys.exit(0)

if not to_close:
    print('Nothing to clean up.')
    sys.exit(0)

closed = 0
for t in to_close:
    target_id = t.get('id')
    url = t.get('url', '?')[:60]
    if target_id:
        try:
            urllib.request.urlopen(f'http://localhost:{cdp_port}/json/close/{target_id}', timeout=2)
            print(f'  Closed: {url}')
            closed += 1
        except Exception as e:
            print(f'  Failed: {url} ({e})')

print(f'\nClosed {closed}/{len(to_close)} tabs')
"
}
