#!/bin/bash
# Server management functions

CDP_PORT=9223

# Cleanup orphaned about:blank tabs (silent, runs in background)
cleanup_orphaned_tabs() {
    # Quick check if CDP is available
    curl -s --connect-timeout 1 "http://localhost:$CDP_PORT/json/list" 2>/dev/null | python3 -c "
import sys, json, urllib.request

try:
    tabs = json.load(sys.stdin)
except:
    sys.exit(0)

blank = [t for t in tabs if t.get('url','').startswith('about:blank')]
if not blank:
    sys.exit(0)

closed = 0
for t in blank:
    target_id = t.get('id')
    if target_id:
        try:
            urllib.request.urlopen(f'http://localhost:$CDP_PORT/json/close/{target_id}', timeout=1)
            closed += 1
        except:
            pass

if closed > 0:
    print(f'Cleaned up {closed} orphaned tabs', file=sys.stderr)
" 2>&1 &
}

start_server() {
    log_debug "start_server called from $(pwd)"

    if check_server_health; then
        log_debug "Server already healthy"
        cleanup_orphaned_tabs
        return 0
    fi

    # Port responds but wsEndpoint missing = zombie state
    if curl -s --connect-timeout 2 "http://localhost:$SERVER_PORT" &>/dev/null; then
        log_debug "Port responds but wsEndpoint missing - zombie state, restarting"
        echo "Server in bad state, restarting..." >&2
        stop_server
        sleep 1
    fi

    echo "Starting dev-browser server..." >&2
    log_debug "Starting server from $DEV_BROWSER_DIR"
    cd "$DEV_BROWSER_DIR" || exit 1

    nohup ./server.sh > "$SERVER_LOG" 2>&1 &
    local pid=$!
    echo $pid > "$SERVER_PID_FILE"
    log_debug "Server started with PID $pid"

    local count=0
    while ! check_server_health; do
        sleep 1
        count=$((count + 1))
        if [[ $count -ge 30 ]]; then
            log_debug "Server startup timeout after 30s"
            print_server_error "Startup timeout (30s)"
            echo "Last 10 lines of server log:" >&2
            tail -10 "$SERVER_LOG" >&2
            return 1
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            log_debug "Server process $pid died during startup"
            print_server_error "Process died during startup"
            echo "Last 10 lines of server log:" >&2
            tail -10 "$SERVER_LOG" >&2
            return 1
        fi
    done

    log_debug "Server ready after ${count}s"
    echo "Server ready on port $SERVER_PORT" >&2

    # Cleanup orphaned tabs in background
    cleanup_orphaned_tabs

    return 0
}

stop_server() {
    log_debug "stop_server called"
    if [[ -f "$SERVER_PID_FILE" ]]; then
        local pid=$(cat "$SERVER_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping server (PID $pid)..." >&2
            log_debug "Killing PID $pid"
            kill "$pid" 2>/dev/null
            rm -f "$SERVER_PID_FILE"
        fi
    fi
    pkill -f "start-server.ts" 2>/dev/null
    log_debug "Server stopped"
    echo "Server stopped" >&2
}

server_status() {
    echo "=== DEV-BROWSER STATUS ==="

    if [[ -f "$SERVER_PID_FILE" ]]; then
        local pid=$(cat "$SERVER_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Process: Running (PID $pid)"
        else
            echo "Process: Dead (stale PID file)"
        fi
    else
        echo "Process: No PID file"
    fi

    if curl -s --connect-timeout 2 "http://localhost:$SERVER_PORT" &>/dev/null; then
        echo "Port $SERVER_PORT: Responding"
    else
        echo "Port $SERVER_PORT: Not responding"
    fi

    if check_server_health; then
        echo "Health: OK (wsEndpoint available)"
        curl -s "http://localhost:$SERVER_PORT/pages" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); pages=d.get('pages',[]); print(f'Pages: {len(pages)} active'); [print(f'  - {p}') for p in pages]" 2>/dev/null
    else
        echo "Health: UNHEALTHY (no wsEndpoint)"
    fi

    if [[ -f "$SKILL_TMP_DIR/sessions.json" ]]; then
        local crashed_at
        crashed_at=$(python3 -c "import json; d=json.load(open('$SKILL_TMP_DIR/sessions.json')); print(d.get('crashedAt',''))" 2>/dev/null)
        if [[ -n "$crashed_at" ]]; then
            echo ""
            echo "*** PREVIOUS SESSION CRASHED at $crashed_at ***"
            python3 -c "import json; d=json.load(open('$SKILL_TMP_DIR/sessions.json')); pages=d.get('lostPages',[]); [print(f'  Lost: {p}') for p in pages]" 2>/dev/null
            echo "  (Re-navigate to lost pages after restart)"
        fi
    fi

    echo ""
    echo "Recent log (last 5 lines):"
    tail -5 "$SERVER_LOG" 2>/dev/null | sed 's/^/  /' || echo "  (no log file)"

    echo ""
    echo "Logs: $DEBUG_LOG | $SERVER_LOG"
    echo "Crash log: $SKILL_TMP_DIR/crash.log"
}
