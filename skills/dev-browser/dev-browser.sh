#!/bin/bash
# Dev-browser wrapper - modular version (v1.5.0 - self-documenting)
# Run with --help for full man-page reference.

show_help() {
cat <<'HELPEOF'
NAME
    dev-browser — browser automation with persistent page state

SYNOPSIS
    dev-browser.sh <command> [args]         Quick commands
    dev-browser.sh --<flag> [page] [args]   Inspection/screenshot commands
    dev-browser.sh --run <script> [args]    Custom TypeScript scripts

RULES
    1. Screenshot path is in OUTPUT. Run command, read the path, then Read() it.
       Never pass a path. Never chain with &&. Never guess.
    2. Never use sleep or setTimeout. Use event-based waits in scripts.
    3. Never add 2>&1. Stdout/stderr are handled correctly.
    4. Never declare client/page in scripts. They are auto-injected.
    5. Recon first. Never guess selectors. Use: goto -> aria -> --inspect -> screenshot.
    6. One command per Bash() call. Do not chain with && or ;.
    7. If broken after 1 retry: msg tools "dev-browser issue: <description>"

COMMANDS
    goto <url>                 Navigate and inspect (forms, buttons, links)
    click <text|ref|selector>  Click element (text match, ARIA ref, or CSS)
    fill "f1=v1 f2=v2"        Fill form fields (auto-detects text/checkbox/radio/select)
    fill '{"f":"v"}'           Fill with JSON (for values containing =)
    select <field> <value>     Select dropdown option
    text <ref|selector>        Get element text content
    eval '<js>'                Execute JavaScript in page
    aria                       ARIA accessibility tree with [ref=eN]
    scroll-to <selector>       Scroll element into view
    upload <selector> <path>   Upload file (searches iframes)
    dismiss-consent            Close GDPR/cookie overlays

INSPECTION
    --screenshot <page>                     Full-page screenshot
    --screenshot <page> --selector '.css'   Element screenshot (clipped)
    --screenshot <page> --scroll-to '.css'  Scroll + viewport screenshot
    --inspect <page>                        Forms + ARIA snapshot with refs
    --page-status <page>                    URL/title + page messages
    --console-snapshot <page>               Console messages
    --annotate <page>                       Screenshot with ref labels + bounding boxes
    --responsive <page>                     4 viewport screenshots + overflow check
    --resize <WxH> [page]                   Resize viewport
    --styles <selector> [page]              CSS cascade inspector
    --element <ref|selector> [page]         Full element inspection

SERVER
    --server                   Start server for current mode
    --stop [--all]             Stop server(s)
    --status                   Show all server states

MODES
    --dev       Default mode (normal testing)
    --stealth   Anti-fingerprint (bypasses bot detection)
    --user      Your real browser session (requires --setup-brave first)
    Mode persists across commands. First --stealth sets mode until --dev resets.

FLAGS
    -p <page>     Target page name (default: "main")
    --cachebust   Add cache-busting query param
    -q            Suppress console error output
    --force       Force click on hidden elements

SCRIPTS
    --run <name>              Run custom TypeScript script
    --chain "cmd|cmd|cmd"     Chain commands
    --list                    List available scripts
    --scenario <name>         Run YAML scenario
    --scenarios               List available scenarios

    Auto-injected globals (no imports needed):
      page, client, resolveField, smartFill
      waitForPageLoad, waitForElement, waitForElementGone
      waitForCondition, waitForURL, waitForNetworkIdle

    Rules: plain JS in evaluate(). Use -p flag for page names.

DIAGNOSTICS
    --tabs                    List all browser tabs
    --cleanup [--all]         Close orphaned tabs
    --cleanup --project <n>   Close specific project page
    --debug                   Show debug log
    --crashes                 Show crash logs
    --wplogin <url>           WordPress auto-login (admin/admin123)
    --setup-brave             Show user-mode setup instructions

OUTPUT FORMATS
    goto       -> URL: <url> / Title: <title> / <pageState>
    click      -> Clicked <type>: <target> / URL: ... / Title: ... / <pageState>
    fill       -> Filled: f1, f2 / <pageState>  |  Not found: f (stderr, exit 1)
    screenshot -> Screenshot saved: /full/path/to/file.png
    inspect    -> Forms + ARIA refs (e1, e2, ... for use with click/text)

ERRORS
    ECONNREFUSED/ECONNRESET    Server crashed. Auto-retries once.
                               Fix: --stop --all && --server
    Cannot redeclare client    Remove connect()/page()/disconnect() from script
    Page 'X' not found         Navigate first: goto <url>
    Field 'X' not found        Wrong name. Use --inspect or aria
    browser-dead               Chrome crashed: --stop --all && --server
HELPEOF
}

show_cheatsheet() {
cat <<'CHEATEOF'
RULES (dev-browser.sh):
  1. One command per Bash() call. Never chain with && or ;
  2. Screenshot path is in OUTPUT — read it, then Read() the file
  3. Never use sleep/setTimeout. Never add 2>&1
  4. Never declare client/page in scripts (auto-injected)
  5. Recon first: goto -> read output -> act

RECIPES:
  Navigate:           dev-browser.sh goto <url>
  Screenshot page:    dev-browser.sh --screenshot main
  Screenshot element: dev-browser.sh --screenshot main --selector 'footer'
  Screenshot scroll:  dev-browser.sh --screenshot main --scroll-to '.section'
  Fill form:          dev-browser.sh fill "user=admin pass=secret"
  Click:              dev-browser.sh click "Submit"
  Inspect:            dev-browser.sh --inspect main
  ARIA tree:          dev-browser.sh aria

Full reference: dev-browser.sh --help
CHEATEOF
}

# Legacy header kept minimal - see show_help() for full reference

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
# Persist mode so subsequent commands (screenshot, inspect) use the same server
if [[ -n "$BROWSER_MODE" ]]; then
    echo "$BROWSER_MODE" > "$SKILL_TMP_DIR/browser_mode"
fi
export BROWSER_MODE
# Re-initialize mode vars with current mode (env or persisted file)
set_mode_vars "$(get_current_mode)"
set -- "${NEW_ARGS[@]}"

# Dispatch commands
case "$1" in
    # Server commands
    --server|--stop|--status)
        source "$LIB_DIR/server.sh"
        case "$1" in
            --server) start_server; exit $? ;;
            --stop) stop_server "$2"; exit 0 ;;
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
            --cleanup) shift; cmd_cleanup "$@"; exit 0 ;;
        esac
        ;;

    # Screenshot commands
    --screenshot|--snap|--diff|--baselines|--responsive|--resize)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/screenshots.sh"
        case "$1" in
            --screenshot)
                # Use server-side screenshot (server's Page object, avoids stale CDP)
                start_server || exit 1
                get_project_paths
                export SCREENSHOTS_DIR="$PROJECT_SCREENSHOTS_DIR"
                export PROJECT_PREFIX=$(get_project_prefix)
                shift # consume --screenshot
                # Parse remaining args: [page] [filename] [--scroll-to <sel|px>] [--selector <css>]
                _page="" _fname="" _scroll_to="" _selector=""
                while [[ $# -gt 0 ]]; do
                    case "$1" in
                        --scroll-to) _scroll_to="${2:-}"; shift 2 ;;
                        --selector) _selector="${2:-}"; shift 2 ;;
                        --*) echo "WARNING: Unknown flag '$1' ignored" >&2; shift ;;
                        *) if [[ -z "$_page" ]]; then _page="$1"; elif [[ -z "$_fname" ]]; then _fname="$1"; else echo "WARNING: Unknown argument '$1' ignored" >&2; fi; shift ;;
                    esac
                done
                [[ -n "$_page" ]] && PAGE_NAME="$_page" && export PAGE_NAME
                export SCRIPT_ARGS="$_fname"
                [[ -n "$_scroll_to" ]] && export SCROLL_TO="$_scroll_to"
                [[ -n "$_selector" ]] && export SELECTOR_TARGET="$_selector"
                export SERVER_PORT
                cd "$DEV_BROWSER_DIR" && run_ts "$BUILTIN_SCRIPTS_DIR/screenshot.ts"
                _exit=$?
                _latest_shot="$PROJECT_SCREENSHOTS_DIR/$(ls -t "$PROJECT_SCREENSHOTS_DIR" 2>/dev/null | head -1)"
                [[ -f "$_latest_shot" ]] && resize_screenshot "$_latest_shot" 2>/dev/null
                exit $_exit
                ;;
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
        show_help
        exit 0
        ;;

    # Cheatsheet (short version for hook injection)
    --cheatsheet)
        show_cheatsheet
        exit 0
        ;;

    # Brave setup helper
    --setup-brave)
        "$DEV_BROWSER_DIR/scripts/setup-brave-debug.sh"
        exit $?
        ;;

    # Quick browsing commands (no --run prefix, agent-browser style)
    goto|click|jsclick|text|fill|select|select-react|aria|eval|upload|dismiss-consent|scroll-to|dismiss-overlays|drag|extract|slide|inject-cookies)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/runscript.sh"
        start_server || exit 1
        # Filter out unknown flags to prevent them leaking into SCRIPT_ARGS
        _cmd="$1"; shift
        _clean_args=()
        _force_click=0
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --force)
                    # Support --force flag for click command
                    if [[ "$_cmd" == "click" ]]; then
                        _force_click=1
                    else
                        echo "WARNING: --force only supported for 'click' command" >&2
                    fi
                    shift
                    ;;
                --*=*) echo "WARNING: Unknown flag '$1' ignored (not a dev-browser option)" >&2; shift ;;
                --*) echo "WARNING: Unknown flag '$1' ignored (not a dev-browser option)" >&2; shift; [[ $# -gt 0 && ! "$1" =~ ^-- && ! "$1" =~ ^https?:// ]] && shift ;;
                *) _clean_args+=("$1"); shift ;;
            esac
        done
        export SCRIPT_ARGS="${_clean_args[*]}"
        # Export individual args for commands that need compound selectors (spaces in args)
        export SCRIPT_ARGC="${#_clean_args[@]}"
        [[ ${#_clean_args[@]} -ge 1 ]] && export SCRIPT_ARG0="${_clean_args[0]}"
        [[ ${#_clean_args[@]} -ge 2 ]] && export SCRIPT_ARG1="${_clean_args[1]}"
        export PROJECT_PREFIX=$(get_project_prefix)
        [[ $_force_click -eq 1 ]] && export FORCE_CLICK=1
        run_script "$BUILTIN_SCRIPTS_DIR/$_cmd.ts"
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
