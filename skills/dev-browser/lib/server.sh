#!/bin/bash
# Server management functions - multi-server support (one per mode)

# Cleanup ALL orphaned tabs not tracked by the server registry (runs in background)
cleanup_orphaned_tabs() {
    {
    # Wait for any pending page creation to complete
    sleep 2

    # Get CDP tab list and server registry
    cdp_json=$(curl -s --connect-timeout 1 -m 3 "http://localhost:$CDP_PORT/json/list" 2>/dev/null) || exit 0
    registry_json=$(curl -s --connect-timeout 1 -m 3 "http://localhost:$SERVER_PORT/pages" 2>/dev/null) || exit 0

    # Close ALL tabs not in registry (not just about:blank)
    # Re-checks registry before each close to avoid race with page creation
    python3 -c "
import sys, json, urllib.request

try:
    tabs = json.loads('''$cdp_json''')
except:
    sys.exit(0)

server_port = '$SERVER_PORT'
cdp_port = '$CDP_PORT'

def get_registered_targets():
    try:
        data = urllib.request.urlopen(f'http://localhost:{server_port}/pages', timeout=2).read()
        registry = json.loads(data)
        return set(registry.get('targets', {}).values())
    except:
        return None  # server unreachable, abort cleanup

closed = 0
for t in tabs:
    tid = t.get('id', '')
    if not tid:
        continue
    # Re-check registry before EACH close (prevents race with page creation)
    protected = get_registered_targets()
    if protected is None:
        break  # server gone, stop
    if tid in protected:
        continue
    try:
        urllib.request.urlopen(f'http://localhost:{cdp_port}/json/close/{tid}', timeout=1)
        closed += 1
    except:
        pass

if closed > 0:
    print(f'Cleaned up {closed} orphaned tab(s)', file=sys.stderr)
" 2>&1
    } &
}

start_server() {
    # Determine mode and set variables
    local mode="${BROWSER_MODE:-dev}"
    set_mode_vars "$mode"

    log_debug "start_server called for mode=$mode (port=$SERVER_PORT)"

    if check_server_health; then
        log_debug "Server already healthy for mode $mode"
        # Fix stale PID file: find actual process listening on our port
        local actual_pid=$(lsof -ti:$SERVER_PORT -sTCP:LISTEN 2>/dev/null | head -1)
        if [[ -n "$actual_pid" ]]; then
            local file_pid=$(cat "$SERVER_PID_FILE" 2>/dev/null)
            if [[ "$actual_pid" != "$file_pid" ]]; then
                log_debug "Fixing stale PID file: $file_pid -> $actual_pid"
                printf '%s' "$actual_pid" > "$SERVER_PID_FILE"
            fi
        fi
        # NOTE: Do NOT run cleanup_orphaned_tabs here. It was spawning a background
        # process on EVERY command invocation, causing races that closed active pages.
        # Cleanup only runs on new server start (below) or explicit --cleanup.
        return 0
    fi

    # Port responds but health fails = zombie state (browser crashed but Express alive)
    if curl -s --connect-timeout 2 "http://localhost:$SERVER_PORT" &>/dev/null; then
        log_debug "Port responds but health check failed - zombie state, restarting"
        echo "Server in bad state (browser likely crashed), restarting..." >&2
        stop_server
        sleep 1
        # Also kill any orphaned CDP processes on the port
        lsof -ti:$CDP_PORT 2>/dev/null | xargs kill -9 2>/dev/null
        sleep 1
    fi

    echo "Starting dev-browser server (mode: $mode, port: $SERVER_PORT)..." >&2
    log_debug "Starting server from $DEV_BROWSER_DIR"
    cd "$DEV_BROWSER_DIR" || exit 1

    # Pass browser mode and ports to server
    nohup env BROWSER_MODE="$mode" HTTP_PORT="$SERVER_PORT" CDP_PORT="$CDP_PORT" DEV_BROWSER_HOME="$DEV_BROWSER_HOME" ./server.sh > "$SERVER_LOG" 2>&1 &
    local pid=$!
    echo $pid > "$SERVER_PID_FILE"
    log_debug "Server started with PID $pid"

    local count=0
    while ! check_server_health; do
        sleep 0.3
        count=$((count + 1))
        if [[ $count -ge 100 ]]; then
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

    log_debug "Server ready after ~$((count * 3 / 10))s"
    echo "Server ready on port $SERVER_PORT" >&2

    # Cleanup orphaned tabs in background
    cleanup_orphaned_tabs

    return 0
}

stop_server() {
    # Stop server for current mode (or all if --all passed)
    local mode="${BROWSER_MODE:-$(get_current_mode)}"

    if [[ "$1" == "--all" ]]; then
        echo "Stopping all dev-browser servers..." >&2
        for m in dev stealth user; do
            set_mode_vars "$m"
            if [[ -f "$SERVER_PID_FILE" ]]; then
                local pid=$(cat "$SERVER_PID_FILE")
                if kill -0 "$pid" 2>/dev/null; then
                    echo "  Stopping $m server (PID $pid)..." >&2
                    kill "$pid" 2>/dev/null
                fi
                rm -f "$SERVER_PID_FILE"
            fi
        done
        pkill -f "start-server.ts" 2>/dev/null
        log_debug "All servers stopped"
        echo "All servers stopped" >&2
    else
        set_mode_vars "$mode"
        log_debug "stop_server called for mode=$mode"
        if [[ -f "$SERVER_PID_FILE" ]]; then
            local pid=$(cat "$SERVER_PID_FILE")
            if kill -0 "$pid" 2>/dev/null; then
                echo "Stopping $mode server (PID $pid)..." >&2
                log_debug "Killing PID $pid"
                kill "$pid" 2>/dev/null
                sleep 1
                # Force kill if still alive
                kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
            fi
            rm -f "$SERVER_PID_FILE"
        fi
        # Also kill any orphaned server processes for this mode
        pkill -f "BROWSER_MODE=$mode.*start-server" 2>/dev/null
        log_debug "Server stopped"
        echo "Server stopped" >&2
    fi
}

server_status() {
    echo "=== DEV-BROWSER STATUS (Multi-Server) ==="
    echo ""

    # Show status of all modes
    for mode in dev stealth user; do
        set_mode_vars "$mode"
        local status="NOT RUNNING"
        local pages=""

        if check_server_health; then
            local pid=$(lsof -ti:$SERVER_PORT -sTCP:LISTEN 2>/dev/null | head -1)
            pid="${pid:-$(cat "$SERVER_PID_FILE" 2>/dev/null)}"
            status="RUNNING (PID $pid, port $SERVER_PORT)"
            pages=$(curl -s -m 2 "http://localhost:$SERVER_PORT/pages" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); pages=d.get('pages',[]); print(f'{len(pages)} pages')" 2>/dev/null)
        elif [[ -f "$SERVER_PID_FILE" ]]; then
            local pid=$(cat "$SERVER_PID_FILE")
            if kill -0 "$pid" 2>/dev/null; then
                status="UNHEALTHY (PID $pid)"
            fi
        fi

        printf "  %-8s %s" "$mode:" "$status"
        [[ -n "$pages" ]] && printf " - %s" "$pages"
        echo ""
    done

    echo ""
    echo "Tip: Use --stealth or --user flag to select mode"
    echo "     Use --stop to stop current mode, --stop --all to stop all"
}
