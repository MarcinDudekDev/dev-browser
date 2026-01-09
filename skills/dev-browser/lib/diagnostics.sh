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
    echo "=== CHROME TABS (via CDP) ==="
    curl -s "http://localhost:9223/json/list" 2>/dev/null | python3 -c "
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
    curl -s "http://localhost:$SERVER_PORT/pages" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); pages=d.get('pages',[]); print(f'{len(pages)} registered'); [print(f'  - {p}') for p in pages]" 2>/dev/null || echo "(server not running)"
}

cmd_cleanup() {
    echo "Cleaning up orphaned about:blank tabs..."
    curl -s "http://localhost:9223/json/list" 2>/dev/null | python3 -c "
import sys, json, urllib.request

try:
    tabs = json.load(sys.stdin)
except:
    print('Server not running')
    sys.exit(1)

blank = [t for t in tabs if t.get('url','').startswith('about:blank')]
print(f'Found {len(blank)} about:blank tabs')

closed = 0
for t in blank:
    target_id = t.get('id')
    if target_id:
        try:
            url = f'http://localhost:9223/json/close/{target_id}'
            urllib.request.urlopen(url, timeout=2)
            print(f'  Closed: {target_id[:20]}...')
            closed += 1
        except Exception as e:
            print(f'  Failed to close {target_id[:20]}: {e}')

print(f'Closed {closed} tabs')
"
}
