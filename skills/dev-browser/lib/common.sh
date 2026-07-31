#!/bin/bash
# Common variables and functions for dev-browser

# Directories
# DEV_BROWSER_HOME: root directory for user data (screenshots, scripts, tmp)
DEV_BROWSER_HOME="${DEV_BROWSER_HOME:-$HOME/.dev-browser}"
SKILL_TMP_DIR="$DEV_BROWSER_HOME/tmp"
mkdir -p "$SKILL_TMP_DIR"

# Config
MAX_SCREENSHOT_DIM=7500
DEBUG_LOG="$SKILL_TMP_DIR/debug.log"
# Audit log always in canonical home dir (not symlink source dir)
AUDIT_LOG="${HOME}/.dev-browser/audit.log"

# Audit logging — permanent record of every command with input/output
# Rotate at 10K lines (keep 5K)
audit_rotate() {
    if [[ $(wc -l < "$AUDIT_LOG" 2>/dev/null || echo 0) -gt 10000 ]]; then
        tail -5000 "$AUDIT_LOG" > "$AUDIT_LOG.tmp" && mv "$AUDIT_LOG.tmp" "$AUDIT_LOG"
    fi
}

# Multi-server port configuration (each mode gets its own server)
# Format: HTTP_PORT / CDP_PORT
#   dev:     9220 / 9221  (moved off 9222 so it can't clash with a real browser)
#   stealth: 9224 / 9225
#   user:    9226 / (user's Chrome CDP, typically 9222)
get_mode_ports() {
    local mode="${1:-dev}"
    case "$mode" in
        dev)     echo "9220 9221" ;;
        stealth) echo "9224 9225" ;;
        user)    echo "9226 9222" ;;  # HTTP 9226, connects to user's Chrome on 9222
        *)       echo "9220 9221" ;;  # default to dev
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

# Initialize mode vars only if not already set (dev-browser.sh handles this)
if [[ -z "$SERVER_PORT" ]]; then
    set_mode_vars "dev"
fi
SCREENSHOTS_DIR="${SCREENSHOTS_DIR:-$DEV_BROWSER_HOME/screenshots}"
# Published command surface. Named builtins/ (not scripts/) because for years this
# dir held three unrelated things under one name — published backends, per-client
# scratch, and private tools — and a blanket gitignore over scripts/*.ts silently
# swallowed real backends along with the scratch it was meant to hide.
BUILTIN_SCRIPTS_DIR="$DEV_BROWSER_DIR/builtins"
# Private reusable tools, versioned in their own private repo, never published here.
DEV_BROWSER_PRIVATE="${DEV_BROWSER_PRIVATE:-$HOME/dev-browser-private}"
PRIVATE_SCRIPTS_DIR="$DEV_BROWSER_PRIVATE/scripts"
USER_SCRIPTS_DIR="${USER_SCRIPTS_DIR:-$DEV_BROWSER_HOME/scripts}"

# Translate a legacy .../skills/dev-browser/scripts/foo.ts argument to builtins/.
# A read-only string rewrite: it deliberately does NOT create a scripts/ directory,
# because any writable path named scripts/ re-invites the collision above.
remap_legacy_scripts_path() {
    local p=$1
    case "$p" in
        "$DEV_BROWSER_DIR"/scripts/*)
            local rest=${p#"$DEV_BROWSER_DIR"/scripts/}
            local cand="$DEV_BROWSER_DIR/builtins/$rest"
            if [[ -e "$cand" ]]; then
                # Print the FULL new path: the caller usually wants to paste it into a
                # file read, and only the wrapper does this remapping. A path that keeps
                # working here while failing every direct read is worse than a clean
                # break unless the replacement is spelled out.
                echo "WARNING: deprecated path scripts/$rest -> builtins/$rest" >&2
                echo "         only dev-browser.sh remaps this; to read the file use:" >&2
                echo "         $cand" >&2
                printf '%s\n' "$cand"
                return 0
            fi
            ;;
    esac
    printf '%s\n' "$p"
}
# Scratch scripts (throwaway per-project .ts) live under the global temp root,
# NEVER inside the skill dir or ~/.claude — see get_scratch_dir() below.
CLAUDE_TMP_ROOT="${CLAUDE_TMP_ROOT:-$HOME/claude-tmp}"
VISUAL_DIFF="${VISUAL_DIFF:-$DEV_BROWSER_HOME/visual-diff}"

# TypeScript runner: bun for file scripts (140ms), tsx for heredocs (660ms).
# Playwright's bundled ws doesn't work in Bun (no HTTP upgrade support).
# Fix: patched utilsBundle.js to use native ws in Bun — see postinstall.sh.
run_ts() {
    # TODO: switch back to bun once oven-sh/bun#9911 merges (PR #27859)
    # Bun is ~2x faster but lacks ws 'upgrade' event, breaking Playwright CDP.
    # All scripts that go through run_script() use Playwright, so tsx is required.
    ./node_modules/.bin/tsx "$@"
}

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
    response=$(curl -s --connect-timeout 1 -m 2 "http://localhost:$SERVER_PORT/health" 2>/dev/null)
    [[ "$response" == "ok" ]]
}

# Is the responder on SERVER_PORT one of OUR dev-browser servers (vs a foreign
# process such as the user's real browser)? Our /health returns "ok" (healthy)
# or "browser-dead" (zombie); a foreign CDP/HTTP server returns neither.
is_our_server() {
    local r
    r=$(curl -s --connect-timeout 1 -m 2 "http://localhost:$SERVER_PORT/health" 2>/dev/null)
    [[ "$r" == "ok" || "$r" == "browser-dead" ]]
}

# Ensure server is healthy, auto-restart once if dead. Exit 1 on failure.
# Requires server.sh to be sourced (start_server/stop_server available).
ensure_server() {
    if check_server_health; then
        return 0
    fi
    # If start_server isn't loaded yet, source it
    if ! type start_server &>/dev/null; then
        source "$DEV_BROWSER_DIR/lib/server.sh"
    fi
    echo "Server not responding, attempting restart..." >&2
    log_debug "ensure_server: health check failed, calling start_server (handles lock+cooldown)"
    # start_server handles zombie detection, stop, lock, and cooldown internally
    if start_server; then
        return 0
    fi
    print_server_error "Auto-restart failed"
    exit 1
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
    # Return cached result if available
    if [[ -n "$_cached_project_prefix" ]]; then
        printf '%s' "$_cached_project_prefix"
        return
    fi

    local result=""

    # Priority 1: tmux session name (most reliable — constant per window)
    if [[ -n "$TMUX" ]]; then
        local tmux_session
        tmux_session=$(tmux display-message -p '#S' 2>/dev/null)
        if [[ -n "$tmux_session" ]]; then
            result="$tmux_session"
        fi
    fi

    # Priority 2: projects.json lookup by cwd
    if [[ -z "$result" ]]; then
        local cwd="$PWD"
        if [[ -f "$HOME/.claude/projects.json" ]]; then
            result=$(python3 -c "
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
    fi

    # Priority 3: directory basename
    if [[ -z "$result" ]]; then
        result=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-20 | tr -d '\n')
    fi

    _cached_project_prefix="$result"
    printf '%s' "$result"
}

# Canonical scratch dir for throwaway per-project scripts:
#   ~/claude-tmp/<project-slug>/dev-browser/
# Falls back to ~/claude-tmp/dev-browser-scratch/ when the slug can't be
# resolved. Created on demand. Never write scratch into the skill directory.
get_scratch_dir() {
    local prefix
    prefix=$(get_project_prefix)
    local dir
    if [[ -z "$prefix" || "$prefix" == "." || "$prefix" == "/" ]]; then
        dir="$CLAUDE_TMP_ROOT/dev-browser-scratch"
    else
        dir="$CLAUDE_TMP_ROOT/$prefix/dev-browser"
    fi
    mkdir -p "$dir" 2>/dev/null
    printf '%s' "$dir"
}

# Resolve page name: accepts a page name, prefixed name, or URL.
# Echoes the resolved target_name on success. Prints error and returns 1 on failure.
# Usage: target_name=$(resolve_page_name "$arg" "$pages_json" "$PREFIX") || return 1
resolve_page_name() {
    local arg="$1"
    local pages_json="$2"
    local prefix="${3:-}"

    # Try prefixed name first
    if [[ -n "$prefix" ]]; then
        local full_name="${prefix}-${arg}"
        if echo "$pages_json" | jq -e --arg n "$full_name" '.pages | index($n)' >/dev/null 2>&1; then
            echo "$full_name"
            return 0
        fi
    fi

    # Try raw name
    if echo "$pages_json" | jq -e --arg n "$arg" '.pages | index($n)' >/dev/null 2>&1; then
        echo "$arg"
        return 0
    fi

    # If arg looks like a URL, find page whose current URL matches
    if [[ "$arg" == http://* || "$arg" == https://* ]]; then
        local page found_name=""
        while IFS= read -r page; do
            local encoded_page
            encoded_page=$(printf '%s' "$page" | jq -sRr '@uri')
            local page_url
            page_url=$(curl -s -m 3 "http://localhost:${SERVER_PORT}/pages/${encoded_page}/url" | jq -r '.url // empty' 2>/dev/null)
            local norm_arg="${arg%/}" norm_url="${page_url%/}"
            if [[ "$norm_url" == "$norm_arg" || "$norm_url" == "$norm_arg"* || "$norm_arg" == "$norm_url"* ]]; then
                found_name="$page"
                break
            fi
        done < <(echo "$pages_json" | jq -r '.pages[]' 2>/dev/null)

        if [[ -n "$found_name" ]]; then
            echo "$found_name"
            return 0
        fi
        echo "No open page found matching URL '${arg}'. Available pages:" >&2
        echo "$pages_json" | jq -r '.pages[]' 2>/dev/null | sed 's/^/  - /' >&2
        return 1
    fi

    # Not found
    echo "Page '${arg}' not found. Available pages:" >&2
    echo "$pages_json" | jq -r '.pages[]' 2>/dev/null | sed 's/^/  - /' >&2
    return 1
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
