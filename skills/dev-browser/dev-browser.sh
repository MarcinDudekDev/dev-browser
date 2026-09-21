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
    --stop [--all] [--force]   Stop server(s). REFUSES if other sessions have
                               open pages (the server is SHARED) — use
                               --cleanup --mine to close only your own tabs,
                               or --force to kill everything anyway.
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
    --scratch-dir             Print (and create) the dir to save scripts in

    Save throwaway scripts to "$(dev-browser.sh --scratch-dir)" — that is
    ~/claude-tmp/<project-slug>/dev-browser/. NEVER write them into the skill
    directory or anywhere under ~/.claude. Run with --run <name> (basename
    without .ts) or --run <absolute-path>.

    Auto-injected globals (no imports needed):
      page, client, resolveField, smartFill
      waitForPageLoad, waitForElement, waitForElementGone
      waitForCondition, waitForURL, waitForNetworkIdle

    Rules: plain JS in evaluate(). Use -p flag for page names.

DIAGNOSTICS
    --tabs                    List all browser tabs
    --cleanup --mine          Close only THIS session's pages (end-of-session)
    --cleanup --only <name>   Close ONE of this session's pages. Use this, not
                              --mine, in a tool that opened a single tab:
                              --mine takes every page the project owns,
                              including ones a human still had open.
    --cleanup [--all]         Close orphaned tabs
    --cleanup --project <n>   Close specific project's pages
    --debug                   Show debug log
    --crashes                 Show crash logs
    --audit [N|errors]        Show last N audit entries (default 20) or errors only
    --wplogin <url>           WordPress auto-login (admin/admin123)
    --setup-brave             Show user-mode setup instructions

OUTPUT FORMATS
    goto       -> URL: <url> / Title: <title> / <pageState>
    click      -> Clicked <type>: <target> / URL: ... / Title: ... / <pageState>
    fill       -> Filled: f1, f2 / <pageState>  |  Not found: f (stderr, exit 1)
    screenshot -> Screenshot saved: /full/path/to/file.png
    inspect    -> Forms + ARIA refs (e1, e2, ... for use with click/text)

ERRORS
    ECONNREFUSED/ECONNRESET    Server down. Fix: --server (it handles zombie
                               restart itself). Do NOT --stop --all — that
                               kills other sessions' tabs.
    Cannot redeclare client    Remove connect()/page()/disconnect() from script
    Page 'X' not found         Navigate first: goto <url>
    Field 'X' not found        Wrong name. Use --inspect or aria
    browser-dead               Chrome crashed. Fix: --server (auto-recovers)

SHARED SERVER ETIQUETTE
    One server is shared by ALL Claude sessions. Other sessions' tabs live
    in the same browser. End of session: --cleanup --mine (never --stop).
    Only --stop --force if --status shows the server truly wedged.
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

# Resolve script location, following the WHOLE symlink chain.
#
# This was a single `readlink` for a long time and appeared to work, because
# there was only ever one hop: ~/Tools/dev-browser.sh -> the real file. Adding a
# second symlink in the skill directory made the chain two hops
#   ~/.claude/skills/dev-browser/dev-browser.sh
#     -> ~/Tools/dev-browser.sh
#       -> ~/dev-browser/skills/dev-browser/dev-browser.sh
# and one readlink stopped at the middle link, so SCRIPT_DIR became ~/Tools and
# LIB_DIR ~/Tools/lib, which does not exist. The failure was quiet in the worst
# way: --help still printed (it runs before the sourced functions are needed),
# so the script LOOKED fine while mode handling and the audit log were dead.
#
# Loop rather than `readlink -f`: this stays correct on any bash, and a relative
# link target must be resolved against the directory of the link that held it,
# not the caller's cwd.
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
    _link_dir="$(cd -P "$(dirname "$SOURCE")" && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ "$SOURCE" != /* ]] && SOURCE="$_link_dir/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
DEV_BROWSER_DIR="$SCRIPT_DIR"
LIB_DIR="$DEV_BROWSER_DIR/lib"

# Source common functions
source "$LIB_DIR/common.sh"

# === Audit logging: re-exec self to capture all output ===
# On first run, re-invoke with _AUDIT_ACTIVE=1, capture stdout+stderr to separate files
if [[ -z "$_AUDIT_ACTIVE" ]]; then
    export _AUDIT_ACTIVE=1
    _audit_tmpdir="${HOME}/.dev-browser/tmp"
    mkdir -p "$_audit_tmpdir"
    _audit_stdout=$(mktemp "$_audit_tmpdir/audit-out-XXXXXX")
    _audit_stderr=$(mktemp "$_audit_tmpdir/audit-err-XXXXXX")
    # Re-run with output captured to FILES, then replay to the caller.
    # NOT a tee pipeline: if the caller closed stdout early, tee died on
    # SIGPIPE and the signal propagated into the inner command — successful
    # clicks exited 141 and sessions "fixed" the phantom failure with
    # --stop --all, killing every other session's tabs.
    "$0" "$@" > "$_audit_stdout" 2> "$_audit_stderr"
    _ec=$?
    # Write audit entry BEFORE replaying output (replay can still SIGPIPE us,
    # but by then the real exit code and the log entry are already safe)
    {
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] CMD: dev-browser.sh $*"
        echo "  EXIT: $_ec"
        if [[ -s "$_audit_stdout" ]]; then
            _lines=$(wc -l < "$_audit_stdout")
            echo "  STDOUT (${_lines} lines):"
            head -50 "$_audit_stdout" | sed 's/^/  | /'
            [[ $_lines -gt 50 ]] && echo "  | ... (truncated, $_lines total)"
        fi
        if [[ -s "$_audit_stderr" ]]; then
            _lines=$(wc -l < "$_audit_stderr")
            echo "  STDERR (${_lines} lines):"
            head -50 "$_audit_stderr" | sed 's/^/  ! /'
            [[ $_lines -gt 50 ]] && echo "  ! ... (truncated, $_lines total)"
        fi
        echo ""
    } >> "$AUDIT_LOG"
    audit_rotate
    # Replay captured output to the caller (fd separation preserved)
    cat "$_audit_stdout"
    cat "$_audit_stderr" >&2
    rm -f "$_audit_stdout" "$_audit_stderr"
    exit "$_ec"
fi
unset _AUDIT_ACTIVE

# Handle global flags: --cachebust, -p/--page, --quiet-console, --stealth, --user
CACHEBUST_FLAG=0
QUIET_CONSOLE="${QUIET_CONSOLE:-0}"
PAGE_NAME="${PAGE_NAME:-main}"
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
        --allow-primary)
            # Explicit opt-in to drive the user's REAL Brave on :9222 (see safety gate).
            export DEV_BROWSER_ALLOW_PRIMARY=1
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
            --stop) shift; stop_server "$@"; exit $? ;;
            --status) server_status; exit 0 ;;
        esac
        ;;

    # Diagnostic commands
    --debug|--crashes|--tabs|--cleanup|--audit)
        source "$LIB_DIR/diagnostics.sh"
        case "$1" in
            --debug) cmd_debug; exit 0 ;;
            --crashes) cmd_crashes; exit 0 ;;
            --tabs) cmd_tabs; exit 0 ;;
            --cleanup) shift; cmd_cleanup "$@"; exit 0 ;;
            --audit)
                if [[ ! -f "$AUDIT_LOG" ]]; then
                    echo "No audit log yet." >&2; exit 1
                fi
                # --audit errors: show only non-zero exits
                # --audit N: show last N entries (default 20)
                if [[ "$2" == "errors" ]]; then
                    grep -B1 -A20 'EXIT: [^0]' "$AUDIT_LOG" | tail -100
                else
                    n="${2:-20}"
                    # Each entry ends with blank line; show last N entries
                    awk -v n="$n" 'BEGIN{RS=""; ORS="\n\n"} {a[NR]=$0} END{for(i=NR-n+1;i<=NR;i++) if(i>0) print a[i]}' "$AUDIT_LOG"
                fi
                exit 0
                ;;
        esac
        ;;

    # Screenshot commands
    --screenshot|--snap|--diff|--baselines|--responsive|--resize)
        source "$LIB_DIR/server.sh"
        source "$LIB_DIR/screenshots.sh"
        case "$1" in
            --screenshot)
                # Use server-side screenshot via curl (avoids client CDP reconnection)
                shift # consume --screenshot
                cmd_screenshot "$@"
                exit $?
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

    # Print (and create) the canonical scratch dir for throwaway .ts scripts
    --scratch-dir)
        get_scratch_dir
        echo
        exit 0
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
        "$BUILTIN_SCRIPTS_DIR/setup-brave-debug.sh"
        exit $?
        ;;

    # Quick browsing commands (no --run prefix, agent-browser style)
    goto|click|jsclick|text|fill|select|select-react|aria|eval|upload|dismiss-consent|scroll-to|dismiss-overlays|drag|extract|slide|inject-cookies|inject-session|keys|wait)
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
