#!/bin/bash
# Common variables and functions for dev-browser

# Directories
SKILL_TMP_DIR="$DEV_BROWSER_DIR/tmp"
mkdir -p "$SKILL_TMP_DIR"

# Config
MAX_SCREENSHOT_DIM=7500
DEBUG_LOG="$SKILL_TMP_DIR/debug.log"

# Multi-server port configuration (each mode gets its own server)
# Format: HTTP_PORT / CDP_PORT
#   dev:     9222 / 9223
#   stealth: 9224 / 9225
#   user:    9226 / (user's Chrome CDP, typically 9222)
get_mode_ports() {
    local mode="${1:-dev}"
    case "$mode" in
        dev)     echo "9222 9223" ;;
        stealth) echo "9224 9225" ;;
        user)    echo "9226 9222" ;;  # HTTP 9226, connects to user's Chrome on 9222
        *)       echo "9222 9223" ;;  # default to dev
    esac
}

# Get current mode (from env or file)
get_current_mode() {
    if [[ -n "$BROWSER_MODE" ]]; then
        echo "$BROWSER_MODE"
    elif [[ -f "$SKILL_TMP_DIR/browser_mode" ]]; then
        cat "$SKILL_TMP_DIR/browser_mode"
    else
        echo "dev"
    fi
}

# Set mode-specific variables (call this after determining mode)
set_mode_vars() {
    local mode="${1:-$(get_current_mode)}"
    local ports=($(get_mode_ports "$mode"))
    SERVER_PORT="${ports[0]}"
    CDP_PORT="${ports[1]}"
    SERVER_PID_FILE="$SKILL_TMP_DIR/server-${mode}.pid"
    SERVER_LOG="$SKILL_TMP_DIR/server-${mode}.log"
    export SERVER_PORT CDP_PORT SERVER_PID_FILE SERVER_LOG
}

# Initialize with default mode (will be overridden when mode is known)
set_mode_vars "dev"
# DEV_BROWSER_HOME: root directory for user data (screenshots, scripts, tools)
# Override via env var or set in ~/.dev-browser/config
DEV_BROWSER_HOME="${DEV_BROWSER_HOME:-$HOME/.dev-browser}"
SCREENSHOTS_DIR="${SCREENSHOTS_DIR:-$DEV_BROWSER_HOME/screenshots}"
BUILTIN_SCRIPTS_DIR="$DEV_BROWSER_DIR/scripts"
USER_SCRIPTS_DIR="${USER_SCRIPTS_DIR:-$DEV_BROWSER_HOME/scripts}"
VISUAL_DIFF="${VISUAL_DIFF:-$DEV_BROWSER_HOME/visual-diff}"

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

# Get project prefix — uses tmux session name (constant per window),
# falls back to projects.json lookup, then directory basename
get_project_prefix() {
    # Priority 1: tmux session name (most reliable — constant per window)
    if [[ -n "$TMUX" ]]; then
        local tmux_session
        tmux_session=$(tmux display-message -p '#S' 2>/dev/null)
        if [[ -n "$tmux_session" ]]; then
            printf '%s' "$tmux_session"
            return
        fi
    fi

    # Priority 2: projects.json lookup by cwd
    local cwd="$PWD"
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
" 2>/dev/null)
    fi

    # Priority 3: directory basename
    if [[ -z "$prefix" ]]; then
        prefix=$(basename "$cwd" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-20 | tr -d '\n')
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
