#!/bin/bash
# Dev-browser wrapper - modular version
# Usage: dev-browser.sh [options] [script.ts]
#
# Server:     --server | --stop | --status
# Screenshots: --screenshot | --snap | --diff | --baselines | --responsive | --resize
# Inspect:    --inspect | --page-status | --console
# Scripts:    --run <name> | --chain "cmd|cmd" | --list | --scenario | --scenarios
# Diagnostics: --debug | --crashes | --tabs | --cleanup
# Other:      --wplogin | --help

# Resolve script location (follow symlinks)
SOURCE="${BASH_SOURCE[0]}"
[[ -L "$SOURCE" ]] && SOURCE="$(readlink "$SOURCE")"
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
DEV_BROWSER_DIR="$SCRIPT_DIR"
LIB_DIR="$DEV_BROWSER_DIR/lib"

# Source common functions
source "$LIB_DIR/common.sh"

# Handle global flags: --cachebust, -p/--page, --quiet-console
CACHEBUST_FLAG=0
QUIET_CONSOLE=0
PAGE_NAME="main"  # Default page name
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
        *)
            NEW_ARGS+=("$1")
            shift
            ;;
    esac
done
[[ $CACHEBUST_FLAG -eq 1 ]] && export CACHEBUST=1
export PAGE_NAME
export QUIET_CONSOLE
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
    --inspect|--page-status|--console)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/inspect.sh"
        case "$1" in
            --inspect) cmd_inspect "$2"; exit $? ;;
            --page-status) cmd_page_status "$2"; exit $? ;;
            --console) cmd_console "$2" "$3"; exit $? ;;
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
esac

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
