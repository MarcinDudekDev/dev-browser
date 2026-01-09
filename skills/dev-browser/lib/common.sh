#!/bin/bash
# Common variables and functions for dev-browser

# Directories
SKILL_TMP_DIR="$DEV_BROWSER_DIR/tmp"
mkdir -p "$SKILL_TMP_DIR"

# Config
MAX_SCREENSHOT_DIM=7500
SERVER_PID_FILE="$SKILL_TMP_DIR/server.pid"
SERVER_LOG="$SKILL_TMP_DIR/server.log"
DEBUG_LOG="$SKILL_TMP_DIR/debug.log"
SERVER_PORT=9222
SCREENSHOTS_DIR="${SCREENSHOTS_DIR:-$HOME/Tools/screenshots}"
BUILTIN_SCRIPTS_DIR="$DEV_BROWSER_DIR/scripts"
USER_SCRIPTS_DIR="$HOME/Tools/dev-browser-scripts"
VISUAL_DIFF="$HOME/Tools/visual-diff"

# Debug logging (keeps last 500 lines)
log_debug() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg" >> "$DEBUG_LOG"
    if [[ $(wc -l < "$DEBUG_LOG" 2>/dev/null || echo 0) -gt 600 ]]; then
        tail -500 "$DEBUG_LOG" > "$DEBUG_LOG.tmp" && mv "$DEBUG_LOG.tmp" "$DEBUG_LOG"
    fi
}

# Check if server is truly healthy (wsEndpoint available, not just port)
check_server_health() {
    local response
    response=$(curl -s --connect-timeout 2 "http://localhost:$SERVER_PORT" 2>/dev/null)
    if [[ $? -ne 0 ]]; then
        return 1
    fi
    if echo "$response" | grep -q "wsEndpoint"; then
        return 0
    fi
    return 1
}

# Print friendly error with recovery instructions
print_server_error() {
    local reason="$1"
    echo "" >&2
    echo "=== DEV-BROWSER ERROR ===" >&2
    echo "Server not available: $reason" >&2
    echo "" >&2
    echo "Quick fixes:" >&2
    echo "  1. Check status:  dev-browser.sh --status" >&2
    echo "  2. Restart:       dev-browser.sh --stop && dev-browser.sh --server" >&2
    echo "  3. View log:      tail -50 $SERVER_LOG" >&2
    echo "  4. Debug log:     tail -50 $DEBUG_LOG" >&2
    echo "" >&2
    echo "If Chrome crashed, close all Chrome windows and retry." >&2
    echo "=========================" >&2
}

# Get project prefix from cwd
get_project_prefix() {
    local cwd="$PWD"
    if [[ -f "$HOME/.claude/projects.json" ]]; then
        local prefix
        prefix=$(python3 -c "
import json, os
cwd = '$cwd'
found = None
try:
    with open(os.path.expanduser('~/.claude/projects.json')) as f:
        registry = json.load(f)
    for name, info in registry.items():
        if info.get('path') == cwd:
            found = name
            break
except:
    pass
if found:
    print(found, end='')
else:
    print(os.path.basename(cwd).lower().replace(' ', '-')[:20], end='')
")
        if [[ -n "$prefix" ]]; then
            printf '%s' "$prefix"
            return
        fi
    fi
    basename "$cwd" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-20 | tr -d '\n'
}

# Get per-project paths for screenshots and temp scripts
get_project_paths() {
    local prefix=$(get_project_prefix)
    PROJECT_SCREENSHOTS_DIR="$SCREENSHOTS_DIR/$prefix"
    PROJECT_TMP_DIR="$SKILL_TMP_DIR/$prefix"
    mkdir -p "$PROJECT_TMP_DIR" "$PROJECT_SCREENSHOTS_DIR"
}

# Resize screenshot if exceeds Claude's limit
resize_screenshot() {
    local img="$1"
    [[ ! -f "$img" ]] && return

    if command -v sips &>/dev/null; then
        local width=$(sips -g pixelWidth "$img" 2>/dev/null | tail -1 | awk '{print $2}')
        local height=$(sips -g pixelHeight "$img" 2>/dev/null | tail -1 | awk '{print $2}')
        if [[ "$width" -gt "$MAX_SCREENSHOT_DIM" ]] 2>/dev/null || [[ "$height" -gt "$MAX_SCREENSHOT_DIM" ]] 2>/dev/null; then
            echo "Resizing screenshot (${width}x${height} -> max ${MAX_SCREENSHOT_DIM}px)..." >&2
            sips --resampleHeightWidthMax "$MAX_SCREENSHOT_DIM" "$img" >/dev/null 2>&1
        fi
    elif command -v convert &>/dev/null; then
        local dims=$(identify -format "%wx%h" "$img" 2>/dev/null)
        local width=${dims%x*}
        local height=${dims#*x}
        if [[ "$width" -gt "$MAX_SCREENSHOT_DIM" ]] 2>/dev/null || [[ "$height" -gt "$MAX_SCREENSHOT_DIM" ]] 2>/dev/null; then
            echo "Resizing screenshot (${width}x${height} -> max ${MAX_SCREENSHOT_DIM}px)..." >&2
            convert "$img" -resize "${MAX_SCREENSHOT_DIM}x${MAX_SCREENSHOT_DIM}>" "$img"
        fi
    fi
}
