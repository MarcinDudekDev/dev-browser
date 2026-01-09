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

# Check if server is truly healthy (uses /health endpoint)
check_server_health() {
    local response
    response=$(curl -s --connect-timeout 2 "http://localhost:$SERVER_PORT/health" 2>/dev/null)
    [[ "$response" == "ok" ]]
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

# Cache file for project prefixes (avoids spawning Python repeatedly)
PREFIX_CACHE_FILE="$SKILL_TMP_DIR/prefix-cache"

# Get project prefix from cwd (cached per-session)
get_project_prefix() {
    local cwd="$PWD"

    # Check cache first (format: path|prefix per line)
    if [[ -f "$PREFIX_CACHE_FILE" ]]; then
        local cached
        cached=$(grep "^${cwd}|" "$PREFIX_CACHE_FILE" 2>/dev/null | head -1 | cut -d'|' -f2)
        if [[ -n "$cached" ]]; then
            printf '%s' "$cached"
            return
        fi
    fi

    # Compute prefix
    local prefix=""
    if [[ -f "$HOME/.claude/projects.json" ]]; then
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
" 2>/dev/null)
    fi

    # Fallback if Python failed
    if [[ -z "$prefix" ]]; then
        prefix=$(basename "$cwd" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-20 | tr -d '\n')
    fi

    # Cache the result (keep last 50 entries)
    if [[ -n "$prefix" ]]; then
        mkdir -p "$(dirname "$PREFIX_CACHE_FILE")"
        # Remove old entry if exists, add new one
        grep -v "^${cwd}|" "$PREFIX_CACHE_FILE" 2>/dev/null | tail -49 > "$PREFIX_CACHE_FILE.tmp" 2>/dev/null || true
        printf '%s|%s\n' "$cwd" "$prefix" >> "$PREFIX_CACHE_FILE.tmp"
        mv "$PREFIX_CACHE_FILE.tmp" "$PREFIX_CACHE_FILE"
    fi

    printf '%s' "$prefix"
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
