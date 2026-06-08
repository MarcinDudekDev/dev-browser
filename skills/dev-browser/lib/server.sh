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

# --- Restart lock & cooldown (prevents multiple sessions from restart-storming) ---
RESTART_COOLDOWN=45  # seconds between restarts

_restart_lock_dir() {
    echo "$SKILL_TMP_DIR/restart-${BROWSER_MODE:-dev}.lock"
}

_acquire_restart_lock() {
    local lock_dir=$(_restart_lock_dir)
    if mkdir "$lock_dir" 2>/dev/null; then
        echo $$ > "$lock_dir/pid"
        return 0
    fi
    # Stale lock? (owner process dead)
    local lock_pid
    lock_pid=$(cat "$lock_dir/pid" 2>/dev/null)
    if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        log_debug "Breaking stale restart lock (PID $lock_pid dead)"
        rm -rf "$lock_dir"
        if mkdir "$lock_dir" 2>/dev/null; then
            echo $$ > "$lock_dir/pid"
            return 0
        fi
    fi
    # Ancient lock? (>60s old — macOS stat -f %m = mtime epoch)
    if [[ -d "$lock_dir" ]]; then
        local lock_mtime now
        lock_mtime=$(stat -f %m "$lock_dir" 2>/dev/null || echo 0)
        now=$(date +%s)
        if [[ $((now - lock_mtime)) -gt 60 ]]; then
            log_debug "Breaking ancient restart lock ($(( now - lock_mtime ))s old)"
            rm -rf "$lock_dir"
            if mkdir "$lock_dir" 2>/dev/null; then
                echo $$ > "$lock_dir/pid"
                return 0
            fi
        fi
    fi
    return 1  # lock held by another live session
}

_release_restart_lock() {
    rm -rf "$(_restart_lock_dir)"
}

_wait_for_restart() {
    local lock_dir=$(_restart_lock_dir)
    local count=0
    log_debug "Waiting for another session to finish restarting..."
    echo "Another session is restarting dev-browser, waiting..." >&2
    while [[ -d "$lock_dir" ]]; do
        sleep 0.5
        count=$((count + 1))
        if [[ $count -ge 70 ]]; then  # 35s timeout
            log_debug "Timed out waiting for restart lock, breaking"
            rm -rf "$lock_dir"
            break
        fi
    done
}

_is_restart_allowed() {
    local ts_file="$SKILL_TMP_DIR/restart-${BROWSER_MODE:-dev}.timestamp"
    [[ ! -f "$ts_file" ]] && return 0
    local last_restart now elapsed
    last_restart=$(cat "$ts_file" 2>/dev/null || echo 0)
    now=$(date +%s)
    elapsed=$((now - last_restart))
    [[ $elapsed -ge $RESTART_COOLDOWN ]]
}

_record_restart() {
    date +%s > "$SKILL_TMP_DIR/restart-${BROWSER_MODE:-dev}.timestamp"
}

start_server() {
    # Determine mode and set variables
    local mode="${BROWSER_MODE:-dev}"
    set_mode_vars "$mode"

    log_debug "start_server called for mode=$mode (port=$SERVER_PORT)"

    # Fast path: already healthy (no lock needed)
    if check_server_health; then
        log_debug "Server already healthy for mode $mode"
        return 0
    fi

    # Cooldown: don't restart if we just restarted recently
    if ! _is_restart_allowed; then
        local ts_file="$SKILL_TMP_DIR/restart-${mode}.timestamp"
        local last_restart=$(cat "$ts_file" 2>/dev/null || echo 0)
        local remaining=$(( RESTART_COOLDOWN - ($(date +%s) - last_restart) ))
        log_debug "Restart cooldown active (${remaining}s remaining)"
        echo "Server restart cooldown: ${remaining}s remaining (prevents restart storms)" >&2
        echo "Wait or force: dev-browser.sh --stop && dev-browser.sh --server" >&2
        return 1
    fi

    # Acquire lock (prevents multiple sessions from restarting simultaneously)
    if ! _acquire_restart_lock; then
        _wait_for_restart
        # Another session may have fixed it
        if check_server_health; then
            echo "Server recovered by another session" >&2
            return 0
        fi
        # Try lock once more
        if ! _acquire_restart_lock; then
            echo "Could not acquire restart lock, server still unhealthy" >&2
            return 1
        fi
    fi

    # Re-check health (may have been fixed while acquiring lock)
    if check_server_health; then
        log_debug "Server became healthy while acquiring lock"
        _release_restart_lock
        return 0
    fi

    # Port responds but health fails = zombie state (browser crashed but Express alive)
    if curl -s --connect-timeout 2 "http://localhost:$SERVER_PORT" &>/dev/null; then
        log_debug "Port responds but health check failed - zombie state, restarting"
        echo "Server in bad state (browser likely crashed), restarting..." >&2
        stop_server
        sleep 1
    fi

    # Kill any orphaned Chrome holding the CDP port (handles dead server + live browser)
    if [[ "$mode" != "user" ]]; then
        _kill_cdp_browser "$CDP_PORT"
    fi

    echo "Starting dev-browser server (mode: $mode, port: $SERVER_PORT)..." >&2
    log_debug "Starting server from $DEV_BROWSER_DIR"
    cd "$DEV_BROWSER_DIR" || { _release_restart_lock; exit 1; }

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
            _release_restart_lock
            return 1
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            log_debug "Server process $pid died during startup"
            print_server_error "Process died during startup"
            echo "Last 10 lines of server log:" >&2
            tail -10 "$SERVER_LOG" >&2
            _release_restart_lock
            return 1
        fi
    done

    log_debug "Server ready after ~$((count * 3 / 10))s"
    echo "Server ready on port $SERVER_PORT" >&2

    # Record restart time for cooldown & release lock
    _record_restart
    cleanup_orphaned_tabs
    _release_restart_lock
    return 0
}

stop_server() {
    # Stop server for current mode (or all if --all passed)
    local mode="${BROWSER_MODE:-$(get_current_mode)}"

    # Clear restart cooldown so --stop && --server works as force-restart
    rm -f "$SKILL_TMP_DIR/restart-${mode}.timestamp"
    _release_restart_lock 2>/dev/null

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
            # Kill orphaned Chromium on this mode's CDP port (not for user mode)
            if [[ "$m" != "user" ]]; then
                _kill_cdp_browser "$CDP_PORT"
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
        # Kill orphaned Chromium on this mode's CDP port (not for user mode)
        if [[ "$mode" != "user" ]]; then
            _kill_cdp_browser "$CDP_PORT"
        fi
        log_debug "Server stopped"
        echo "Server stopped" >&2
    fi
}

# Kill Chromium process launched with a specific CDP port (cleanup orphans after server stop)
# Finds Chrome by its --remote-debugging-port arg — no lsof (hangs on macOS) or fuser (missing on macOS)
# Also removes SingletonLock to prevent "profile already in use" errors on next launch
_kill_cdp_browser() {
    local port="$1"
    [[ -z "$port" ]] && return
    local browser_pid
    browser_pid=$(pgrep -f "remote-debugging-port=${port}" 2>/dev/null | head -1)
    if [[ -n "$browser_pid" ]]; then
        log_debug "Killing orphaned browser on CDP port $port (PID $browser_pid)"
        echo "  Killing orphaned browser (PID $browser_pid on port $port)..." >&2
        kill "$browser_pid" 2>/dev/null
        sleep 0.5
        kill -0 "$browser_pid" 2>/dev/null && kill -9 "$browser_pid" 2>/dev/null
    fi

    # Clean up SingletonLock files left behind by force-killed Chromium
    # Without this, next launch fails with "profile already in use"
    for mode_dir in "$DEV_BROWSER_HOME"/profiles/*/browser-data; do
        [[ -f "$mode_dir/SingletonLock" ]] && rm -f "$mode_dir/SingletonLock" && log_debug "Removed stale SingletonLock in $mode_dir"
    done
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
            local pid=$(cat "$SERVER_PID_FILE" 2>/dev/null)
            status="RUNNING (PID ${pid:-?}, port $SERVER_PORT)"
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
