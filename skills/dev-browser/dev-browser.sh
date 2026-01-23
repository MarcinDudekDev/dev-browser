#!/bin/bash
# Dev-browser wrapper - modular version (v1.4.1 - improved timeouts)
# Usage: dev-browser.sh [options] [script.ts]
#
# ╔════════════════════════════════════════════════════════════════════════════╗
# ║  ⚠️  SCREENSHOT USAGE - READ THIS FIRST!                                   ║
# ╠════════════════════════════════════════════════════════════════════════════╣
# ║  ❌ NEVER pass a path:    --screenshot main /tmp/shot.png                  ║
# ║  ❌ NEVER chain with &&:  --screenshot main && Read(...)                   ║
# ║  ❌ NEVER guess paths:    Read("/Users/.../screenshots/main.png")          ║
# ║                                                                            ║
# ║  ✅ CORRECT: Run the command, READ THE OUTPUT for the actual path          ║
# ║     Example: --screenshot main                                             ║
# ║     Output:  Screenshot saved: /Users/.../screenshot_main_1705123456.png   ║
# ║     Then:    Use that RETURNED path with Read()                            ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# ╔════════════════════════════════════════════════════════════════════════════╗
# ║  ⚠️  AVOID SLEEP PATTERNS - USE EVENT-BASED WAITING!                       ║
# ╠════════════════════════════════════════════════════════════════════════════╣
# ║  ❌ BAD:  sleep 3 && dev-browser.sh click 'Submit'                         ║
# ║  ❌ BAD:  sleep 5; dev-browser.sh --screenshot main                        ║
# ║                                                                            ║
# ║  ✅ GOOD: Use event-based waiting in your scripts:                         ║
# ║     await waitForElement(page, '.success-message');                        ║
# ║     await waitForURL(page, /success/);                                     ║
# ║     await waitForNetworkIdle(page);                                        ║
# ║     await waitForCondition(page, () => document.querySelector('.done'));   ║
# ║                                                                            ║
# ║  Sleep + command chains cause backgrounding and timeout issues.            ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# Modes:      --dev (default) | --stealth (anti-fingerprint) | --user (main browser)
# Server:     --server | --stop [--all] | --status (multi-server: each mode runs independently)
# Quick:      goto <url> | click <text|ref> | fill <ref> <text> | select <ref> <value> | text <ref> | aria
# Screenshots: --screenshot | --snap | --diff | --baselines | --responsive | --resize
# Inspect:    --inspect | --page-status | --console | --console-snapshot | --styles | --element | --annotate | --watch-design
# Scripts:    --run <name> | --chain "cmd|cmd" | --list | --scenario | --scenarios
# Diagnostics: --debug | --crashes | --tabs | --cleanup
# Other:      --wplogin | --setup-brave | --help

# Resolve script location (follow symlinks)
SOURCE="${BASH_SOURCE[0]}"
[[ -L "$SOURCE" ]] && SOURCE="$(readlink "$SOURCE")"
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
DEV_BROWSER_DIR="$SCRIPT_DIR"
LIB_DIR="$DEV_BROWSER_DIR/lib"

# Source common functions
source "$LIB_DIR/common.sh"

# Handle global flags: --cachebust, -p/--page, --quiet-console, --stealth, --user
CACHEBUST_FLAG=0
QUIET_CONSOLE=0
PAGE_NAME="main"  # Default page name
BROWSER_MODE=""  # empty = use current server mode, or dev if starting fresh
NEW_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --cachebust)
            CACHEBUST_FLAG=1
            shift
            ;;
        -p|--page)
            PAGE_NAME="$2"
            shift 2
            ;;
        --quiet-console|-q)
            QUIET_CONSOLE=1
            shift
            ;;
        --stealth)
            BROWSER_MODE="stealth"
            shift
            ;;
        --user)
            BROWSER_MODE="user"
            shift
            ;;
        --dev)
            BROWSER_MODE="dev"
            shift
            ;;
        *)
            NEW_ARGS+=("$1")
            shift
            ;;
    esac
done
[[ $CACHEBUST_FLAG -eq 1 ]] && export CACHEBUST=1
export PAGE_NAME
export QUIET_CONSOLE
export BROWSER_MODE
set -- "${NEW_ARGS[@]}"

# Dispatch commands
case "$1" in
    # Server commands
    --server|--stop|--status)
        source "$LIB_DIR/server.sh"
        case "$1" in
            --server) start_server; exit $? ;;
            --stop) stop_server; exit 0 ;;
            --status) server_status; exit 0 ;;
        esac
        ;;

    # Diagnostic commands
    --debug|--crashes|--tabs|--cleanup)
        source "$LIB_DIR/diagnostics.sh"
        case "$1" in
            --debug) cmd_debug; exit 0 ;;
            --crashes) cmd_crashes; exit 0 ;;
            --tabs) cmd_tabs; exit 0 ;;
            --cleanup) cmd_cleanup; exit 0 ;;
        esac
        ;;

    # Screenshot commands
    --screenshot|--snap|--diff|--baselines|--responsive|--resize)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/screenshots.sh"
        case "$1" in
            --screenshot) cmd_screenshot "$2" "$3"; exit $? ;;
            --snap) "$VISUAL_DIFF" --snap "${2:-main}"; exit $? ;;
            --diff) "$VISUAL_DIFF" --compare "${2:-main}"; exit $? ;;
            --baselines) "$VISUAL_DIFF" --list; exit $? ;;
            --responsive) cmd_responsive "$2" "$3"; exit $? ;;
            --resize) cmd_resize "$2" "$3" "$4"; exit $? ;;
        esac
        ;;

    # Inspect commands
    --inspect|--page-status|--console|--console-snapshot|--styles|--element|--annotate|--watch-design)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/inspect.sh"
        case "$1" in
            --inspect) cmd_inspect "$2"; exit $? ;;
            --page-status) cmd_page_status "$2"; exit $? ;;
            --console) cmd_console "$2" "$3"; exit $? ;;
            --console-snapshot) cmd_console_snapshot "$2"; exit $? ;;
            --styles) cmd_styles "$2" "$3"; exit $? ;;
            --element) cmd_element "$2" "$3"; exit $? ;;
            --annotate) cmd_annotate "$2" "$3"; exit $? ;;
            --watch-design) cmd_watch_design "$2" "$3" "$4"; exit $? ;;
        esac
        ;;

    # Script commands
    --run|--list|--scenario|--scenarios)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/scripts.sh"
        case "$1" in
            --run) shift; cmd_run "$@"; exit $? ;;
            --list) cmd_list; exit 0 ;;
            --scenario) cmd_scenario "$2"; exit $? ;;
            --scenarios) cmd_scenarios; exit 0 ;;
        esac
        ;;

    # Chain commands (special handling to preserve args)
    --chain)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/runscript.sh"
        start_server || exit 1
        export SCRIPT_ARGS="$2"
        run_script "$BUILTIN_SCRIPTS_DIR/chain.ts"
        exit $?
        ;;

    # WordPress login
    --wplogin)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/wplogin.sh"
        cmd_wplogin "$2"
        exit $?
        ;;

    # Help
    --help|-h)
        head -10 "$0" | tail -8
        exit 0
        ;;

    # Brave setup helper
    --setup-brave)
        "$DEV_BROWSER_DIR/scripts/setup-brave-debug.sh"
        exit $?
        ;;

    # Quick browsing commands (no --run prefix, agent-browser style)
    goto|click|text|fill|select|aria)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/runscript.sh"
        start_server || exit 1
        export SCRIPT_ARGS="${*:2}"
        export PROJECT_PREFIX=$(get_project_prefix)
        run_script "$BUILTIN_SCRIPTS_DIR/$1.ts"
        exit $?
        ;;
esac

# Detect wrong syntax: URL passed directly without command
if [[ -n "$1" && "$1" =~ ^https?:// ]]; then
    echo "ERROR: Wrong syntax - URL passed directly without command" >&2
    echo "" >&2
    echo "ALWAYS read tool/skill documentation BEFORE using it!" >&2
    echo "Run: /dev-browser to see usage" >&2
    echo "" >&2
    echo "Example: dev-browser.sh goto $1" >&2
    exit 1
fi

# Default: run script
source "$LIB_DIR/server.sh"
source "$LIB_DIR/runscript.sh"

if [[ -n "$1" && -f "$1" ]]; then
    log_debug "Running script file: $1"
else
    log_debug "Running inline script from stdin"
fi

start_server || exit 1
run_script "$@"
