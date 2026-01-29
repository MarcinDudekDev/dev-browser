#!/bin/bash
# Diagnostic commands: debug, crashes, tabs, cleanup

cmd_debug() {
    echo "=== RECENT DEBUG LOG (last 50 lines) ==="
    tail -50 "$DEBUG_LOG" 2>/dev/null || echo "(no debug log yet)"
}

cmd_crashes() {
    echo "=== CRASH LOG ==="
    if [[ -f "$SKILL_TMP_DIR/crash.log" ]]; then
        tail -100 "$SKILL_TMP_DIR/crash.log"
    else
        echo "(no crashes recorded)"
    fi
    echo ""
    echo "=== LAST SESSION INFO ==="
    if [[ -f "$SKILL_TMP_DIR/sessions.json" ]]; then
        cat "$SKILL_TMP_DIR/sessions.json"
    else
        echo "(no session info)"
    fi
}

cmd_tabs() {
    # Find running server by checking all mode ports
    local _cdp="" _http=""
    for _mode in dev stealth user; do
        local _ports=($(get_mode_ports "$_mode"))
        if curl -s --connect-timeout 1 "http://localhost:${_ports[0]}/health" 2>/dev/null | grep -q ok; then
            _http="${_ports[0]}"; _cdp="${_ports[1]}"; break
        fi
    done
    [[ -z "$_cdp" ]] && _cdp="$CDP_PORT"
    [[ -z "$_http" ]] && _http="$SERVER_PORT"

    echo "=== CHROME TABS (via CDP port $_cdp) ==="
    curl -s "http://localhost:$_cdp/json/list" 2>/dev/null | python3 -c "
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
    curl -s "http://localhost:$_http/pages" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); pages=d.get('pages',[]); print(f'{len(pages)} registered'); [print(f'  - {p}') for p in pages]" 2>/dev/null || echo "(server not running)"
}

cmd_cleanup() {
    # Usage: --cleanup [--all | --project <prefix> | --unregistered]
    # Default (no args): close about:blank tabs only
    # --all: close ALL unregistered tabs (keeps only registry pages)
    # --project <prefix>: close registry page for a specific project (e.g. tools, marketing)
    # --unregistered: close all tabs not in registry
    local mode="${1:-blank}"
    local project_prefix="$2"

    # Find running server
    for _mode in dev stealth user; do
        local _ports=($(get_mode_ports "$_mode"))
        if curl -s --connect-timeout 1 "http://localhost:${_ports[0]}/health" 2>/dev/null | grep -q ok; then
            SERVER_PORT="${_ports[0]}"; CDP_PORT="${_ports[1]}"; break
        fi
    done

    # Get registered pages from server
    local registry_json
    registry_json=$(curl -s "http://localhost:$SERVER_PORT/pages" 2>/dev/null)

    curl -s "http://localhost:$CDP_PORT/json/list" 2>/dev/null | python3 -c "
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
registered_targets = set()
for name in registered:
    try:
        import urllib.parse
        encoded = urllib.parse.quote(name)
        # We can't easily get target IDs without another API call, so skip
    except:
        pass

print(f'Total: {len(tabs)} tabs, {len(registered)} registered pages')
print(f'Registered: {sorted(registered)}')
print()

to_close = []

if mode == 'blank':
    to_close = [t for t in tabs if t.get('url','').startswith('about:blank')]
    print(f'Mode: close about:blank tabs ({len(to_close)} found)')

elif mode == '--all' or mode == '--unregistered':
    # Close everything except tabs that match registered page URLs
    # We can't match by target ID easily, so keep 1 tab per registered page
    kept = 0
    for t in tabs:
        url = t.get('url', '')
        # Skip iframes (stripe, etc)
        if any(x in url.lower() for x in ['stripe.com', 'stripe.network', 'platform.twitter', 'recaptcha']):
            to_close.append(t)
            continue
        if url.startswith('about:'):
            to_close.append(t)
            continue
        # Keep if we still have registered pages to protect
        if kept < len(registered):
            kept += 1
            continue
        to_close.append(t)
    print(f'Mode: close unregistered tabs ({len(to_close)} found, keeping {kept} registered)')

elif mode == '--project':
    if not project_prefix:
        print('Usage: --cleanup --project <prefix>')
        print('Example: --cleanup --project tools')
        sys.exit(1)
    # Close the registry page for this project via DELETE API
    page_name = f'{project_prefix}-main'
    if page_name in registered:
        try:
            import urllib.parse
            encoded = urllib.parse.quote(page_name)
            req = urllib.request.Request(f'http://localhost:{server_port}/pages/{encoded}', method='DELETE')
            urllib.request.urlopen(req, timeout=2)
            print(f'Closed registered page: {page_name}')
        except Exception as e:
            print(f'Failed to close {page_name}: {e}')
    else:
        print(f'No registered page found for prefix \"{project_prefix}\"')
        print(f'Registered: {sorted(registered)}')
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
