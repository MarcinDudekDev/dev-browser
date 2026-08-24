#!/bin/bash
# Default script execution with auto-recovery

# Check for crash info and notify agent
check_crash_recovery() {
    local mode="${BROWSER_MODE:-dev}"
    local sessions_file="$SKILL_TMP_DIR/sessions-${mode}.json"
    if [[ -f "$sessions_file" ]] && grep -q '"crashedAt"' "$sessions_file" 2>/dev/null; then
        local crashed_at
        crashed_at=$(grep -o '"crashedAt"[[:space:]]*:[[:space:]]*"[^"]*"' "$sessions_file" | head -1 | sed 's/.*: *"//;s/"//')
        if [[ -n "$crashed_at" ]]; then
            echo "" >&2
            echo "=== DEV-BROWSER RECOVERY ===" >&2
            echo "Previous session crashed at $crashed_at" >&2
            # Extract lost pages with grep
            if grep -q '"lostPages"' "$sessions_file" 2>/dev/null; then
                echo "Lost pages that need re-navigation:" >&2
                grep -o '"lostPages"[[:space:]]*:[[:space:]]*\[[^]]*\]' "$sessions_file" | grep -o '"[^"]*"' | tail -n +2 | sed 's/"//g' | while read -r p; do
                    echo "  - $p" >&2
                done
                echo "" >&2
                echo "Chrome may have restored the tabs, but you need to re-register them." >&2
                echo "Tip: Navigate to your test URL again with page.goto()" >&2
            fi
            echo "===========================" >&2
            echo "" >&2
            return 0  # crash detected
        fi
    fi
    return 1  # no crash
}

## Server-eval fast path: bypass tsx for pure page.evaluate() scripts
## Scripts place a shell handler in scripts/<name>.sh alongside the .ts file
## The .sh file receives SCRIPT_ARGS and SERVER_PORT/PAGE_NAME/PROJECT_PREFIX env vars
## and uses curl to hit the server's /evaluate endpoint directly (~50ms vs ~700ms)
run_script_fast() {
    local shell_script="$1"
    # PROJECT_PREFIX is already exported by dev-browser.sh — use it as-is
    export SERVER_PORT PAGE_NAME DEV_BROWSER_DIR
    bash "$shell_script"
}

## Decide what to do about a .sh companion sitting next to a .ts script.
## Echoes exactly one of: none | run:<path> | announce:<path> | refuse:<path>
##
## Pure decision, no side effects, so it can be tested directly — see
## src/companion-guard.test.ts.
##
## WHY THIS IS NOT JUST "run it"
## -----------------------------
## The companion fast path is a deliberate, reviewed pairing for the shipped
## commands in builtins/ (12 of them: goto, click, fill, aria, ...). There the
## .sh is version-controlled next to its .ts and running it is the whole point.
##
## Anywhere else the same rule silently swaps out the code you asked to run.
## On 2026-08-24 a scratch ~/claude-tmp/dev-browser/probe.ts ran a stale
## probe.sh from 2026-07-31 that had nothing to do with it, and printed that
## script's output as if it were the caller's. It was caught only because the
## output was obviously unrelated; a closer collision reads as a passing test.
## Silently running different code than the caller named is worse than an error.
##
## So: shipped pairs stay silent and unchanged, scratch pairs must announce
## themselves, and the specific shape of the accident above — a companion OLDER
## than the .ts next to it — is refused outright.
resolve_companion() {
    local script_file="$1"
    [[ -n "$script_file" && -f "$script_file" ]] || { echo "none"; return 0; }

    local companion="${script_file%.ts}.sh"
    [[ -f "$companion" ]] || { echo "none"; return 0; }

    # Shipped builtins: the intended use. Silent, so this guard cannot
    # reintroduce the per-command stderr noise just removed in 9115b4c.
    local companion_dir builtins_dir
    companion_dir="$(cd "$(dirname "$companion")" 2>/dev/null && pwd)"
    builtins_dir="$(cd "$DEV_BROWSER_DIR/builtins" 2>/dev/null && pwd)"
    if [[ -n "$builtins_dir" && "$companion_dir" == "$builtins_dir" ]]; then
        echo "run:$companion"; return 0
    fi

    # Outside builtins/: a companion older than the .ts it would replace is the
    # collision shape, not a pairing anyone just wrote.
    if [[ "$companion" -ot "$script_file" ]]; then
        if [[ "${DEV_BROWSER_ALLOW_STALE_COMPANION:-0}" == "1" ]]; then
            echo "announce:$companion"; return 0
        fi
        echo "refuse:$companion"; return 0
    fi

    echo "announce:$companion"
}

run_script() {
    local script_file="$1"

    # Fast path: check for .sh companion script (server-side, no tsx)
    local _companion_decision _companion
    _companion_decision="$(resolve_companion "$script_file")"
    _companion="${_companion_decision#*:}"
    case "$_companion_decision" in
        run:*)
            run_script_fast "$_companion"
            local fast_exit=$?
            # Exit 99 = ARIA ref or feature needing tsx; fall through
            [[ $fast_exit -ne 99 ]] && return $fast_exit
            ;;
        announce:*)
            echo "NOTE: dev-browser is running a companion shell script, not the .ts you named." >&2
            echo "  running:  $_companion" >&2
            echo "  you said: $script_file" >&2
            echo "  A <name>.sh next to <name>.ts always wins — it is the server-side fast path." >&2
            echo "  If that is not what you wanted, rename your script or delete the .sh." >&2
            run_script_fast "$_companion"
            local fast_exit=$?
            [[ $fast_exit -ne 99 ]] && return $fast_exit
            ;;
        refuse:*)
            echo "" >&2
            echo "ERROR: refusing to silently run a stale companion script." >&2
            echo "  you asked for: $script_file" >&2
            echo "  companion:     $_companion" >&2
            echo "" >&2
            echo "  dev-browser runs <name>.sh when it sits next to <name>.ts, but this" >&2
            echo "  companion is OLDER than the script you named, which almost always means" >&2
            echo "  a leftover file happens to share the name — not a pair you wrote." >&2
            echo "  Running it would execute code you did not ask for and print its output" >&2
            echo "  as if it were yours." >&2
            echo "" >&2
            echo "  Pick one:" >&2
            echo "    rm $_companion                      # it is junk" >&2
            echo "    mv $script_file <something-else>.ts # keep both, drop the collision" >&2
            echo "    DEV_BROWSER_ALLOW_STALE_COMPANION=1 <your command>  # you meant it" >&2
            echo "" >&2
            return 1
            ;;
    esac

    local PREFIX=$(get_project_prefix)
    # Export it: src/client.ts reads process.env.PROJECT_PREFIX to tell the server
    # which project owns a page, so the per-project tab cap can be enforced.
    export PROJECT_PREFIX="$PREFIX"
    local SCRIPT=""
    local MAX_RETRIES=1
    local retry_count=0

    # Read script from file or stdin
    if [[ -n "$script_file" && -f "$script_file" ]]; then
        SCRIPT=$(cat "$script_file")
    else
        SCRIPT=$(cat)
    fi

    # Strip boilerplate for backward compatibility with user scripts (not builtins).
    # Builtins and private tools are written against the auto-injected client/page,
    # so they must be passed through untouched.
    if [[ -n "$script_file" \
          && "$script_file" != "$BUILTIN_SCRIPTS_DIR"/* \
          && "$script_file" != "$PRIVATE_SCRIPTS_DIR"/* ]]; then
        SCRIPT=$(echo "$SCRIPT" | sed -E \
            -e '/^[[:space:]]*(const|let|var)[[:space:]]+client[[:space:]]*=[[:space:]]*await[[:space:]]+connect\(\)/d' \
            -e '/^[[:space:]]*(const|let|var)[[:space:]]+page[[:space:]]*=[[:space:]]*await[[:space:]]+client\.page\(/d' \
            -e '/^[[:space:]]*await[[:space:]]+client\.disconnect\(\)/d')
    fi

    # Strip imports that the wrapper auto-provides (applies to ALL scripts including builtins)
    SCRIPT=$(echo "$SCRIPT" | sed -E \
        -e '/^[[:space:]]*(import|const|let|var).*\{[^}]*(resolveField|smartFill)[^}]*\}.*from/d' \
        -e '/^[[:space:]]*(import|const|let|var).*\{[^}]*(waitForPageLoad|waitForElement|waitForElementGone|waitForCondition|waitForURL|waitForNetworkIdle)[^}]*\}.*from/d')

    # Create temp script inside DEV_BROWSER_DIR so Bun can resolve @/ path alias
    # from package.json (Bun searches for package.json from script location, not cwd)
    mkdir -p "$DEV_BROWSER_DIR/tmp"
    local TEMP_SCRIPT
    TEMP_SCRIPT=$(mktemp "$DEV_BROWSER_DIR/tmp/script-XXXXXX")
    mv "$TEMP_SCRIPT" "${TEMP_SCRIPT}.mts"
    TEMP_SCRIPT="${TEMP_SCRIPT}.mts"
    trap "rm -f $TEMP_SCRIPT" EXIT

    # Write the complete script with console capture
    cat > "$TEMP_SCRIPT" << ENDOFSCRIPT
// Auto-injected by wrapper.sh
const __PROJECT_PREFIX = "${PREFIX}";
const __SERVER_PORT = "${SERVER_PORT}";
const __pageName = (name: string) => __PROJECT_PREFIX + "-" + name;

// Console message collector
const __consoleMessages: Array<{type: string, text: string}> = [];

// DIALOG RACE GUARD (the browser is SHARED).
// A JS dialog is dismissed by whichever CDP connection sees it first: any other
// session's Playwright connection with no dialog listener auto-dismisses it. Our
// dismiss() then loses the race and rejects with "No dialog is showing" from
// inside an async event handler — outside every try/catch — killing the run.
// Measured: 3 whole --run scripts killed this way in 2 days, incl. a 64-page sweep.
// Layer 2 of the guard (layer 1 is the per-page handler below) — this also covers
// dialog handlers registered by the USER's own script, which we cannot wrap.
// Match the FAMILY, not one spelling. A lost race surfaces with at least two
// different messages depending on who won it, and enumerating today's strings is
// how these guards rot (see: tool_name 'Task' vs 'Agent'):
//   "No dialog is showing"                      <- CDP: another CONNECTION dismissed it
//   "Cannot dismiss dialog which is already handled!"  <- Playwright: this connection did
// Both mean the same benign thing: the dialog is already gone, so our dismiss had
// nothing to do. A dismiss that fails because the dialog vanished can never break
// correctness — the dialog is closed either way — so the whole family is safe to
// swallow. Real dialog bugs (a dialog that never opens, a hung page) do not land here.
const __isBenignDialogRace = (err: unknown): boolean => {
    const m = String((err as {message?: string})?.message ?? err);
    if (!/dialog/i.test(m)) return false;
    return /no dialog is showing|already handled|handleJavaScriptDialog/i.test(m);
};
process.on("unhandledRejection", (err: unknown): void => {
    if (__isBenignDialogRace(err)) return;  // another connection already dismissed it
    throw err;  // anything else keeps today's fail-loud behaviour
});

// Override client.page to auto-prefix and capture console
const __originalConnect = (await import("@/client.js")).connect;
const connect = async (url?: string) => {
    // Use mode-specific port unless explicitly overridden
    const serverUrl = url ?? \`http://localhost:\${__SERVER_PORT}\`;
    const client = await __originalConnect(serverUrl);
    const originalPage = client.page.bind(client);
    const originalList = client.list.bind(client);
    client.page = async (name: string) => {
        // Try prefixed name first, then raw name for cross-project access
        const prefixedName = __pageName(name);
        const pages = await originalList();
        let pageName = prefixedName;
        if (!pages.includes(prefixedName) && pages.includes(name)) {
            pageName = name;
        }
        const page = await originalPage(pageName);
        // Auto-capture console messages
        page.on('console', (msg: any) => {
            __consoleMessages.push({ type: msg.type(), text: msg.text() });
        });
        page.on('pageerror', (err: any) => {
            __consoleMessages.push({ type: 'error', text: err.message });
        });
        // Dialog race guard, layer 1: keep dialogs from blocking the page, but
        // never let a lost dismiss() race take the process down. Registering this
        // also stops OUR connection from silently auto-dismissing behind the
        // user's back — their own handler still runs first if they set one.
        page.on('dialog', (d: any) => {
            void Promise.resolve(d.dismiss()).catch(() => {});
        });
        return page;
    };
    // Expose console messages
    (client as any).getConsoleMessages = () => __consoleMessages;
    (client as any).printConsoleErrors = () => {
        const errors = __consoleMessages.filter(m => m.type === 'error');
        if (errors.length > 0) {
            console.log("\\n=== CONSOLE ERRORS ===");
            errors.forEach(e => console.log("[ERROR]", e.text));
        }
    };
    return client;
};
const { waitForPageLoad, waitForElement, waitForElementGone, waitForCondition, waitForURL, waitForNetworkIdle } = await import("@/client.js");
const { resolveField, smartFill } = await import("@/resolve-field.js");

// Auto-injected: client and page (from -p flag, default "main")
const client = await connect();
const page = await client.page("${PAGE_NAME:-main}");

// User script starts here
${SCRIPT}

// Auto-print viewport info
try {
    const __vp = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    console.log("\\nViewport: " + __vp.width + "x" + __vp.height);
} catch (__e) {}

// Auto-print console errors (unless --quiet-console/-q flag)
if ("${QUIET_CONSOLE:-0}" !== "1") {
    const errors = __consoleMessages.filter(m => m.type === 'error');
    if (errors.length > 0) {
        console.log("\\n=== CONSOLE ERRORS (" + errors.length + ") ===");
        errors.forEach(e => console.log("[ERROR]", e.text));
    }
}

// Auto-disconnect (injected by wrapper)
await client.disconnect();
ENDOFSCRIPT

    # Run with retry on server failure
    while true; do
        cd "$DEV_BROWSER_DIR"
        local output
        local exit_code
        output=$(run_ts "$TEMP_SCRIPT" 2>&1)
        exit_code=$?

        # Success - print output and exit
        if [[ $exit_code -eq 0 ]]; then
            echo "$output"
            return 0
        fi

        # Check if this is a server connection error
        if echo "$output" | grep -qE "ECONNREFUSED|ECONNRESET|EPIPE|fetch failed|socket hang up"; then
            retry_count=$((retry_count + 1))
            if [[ $retry_count -le $MAX_RETRIES ]]; then
                echo "" >&2
                echo "=== SERVER CONNECTION FAILED ===" >&2
                echo "Attempting recovery (retry $retry_count/$MAX_RETRIES)..." >&2

                # Restart server (handles stop, lock, and cooldown internally)
                start_server || {
                    echo "Failed to restart server" >&2
                    echo "$output"
                    return 1
                }

                # Check for crash recovery info
                check_crash_recovery

                echo "Retrying script..." >&2
                echo "===========================" >&2
                echo "" >&2
                continue
            fi
        fi

        # Check for common boilerplate mistakes
        if echo "$output" | grep -qE "Cannot redeclare.*'(client|page)'|Identifier '(client|page)' has already been declared"; then
            echo "" >&2
            echo "=== SCRIPT ERROR: Duplicate declarations ===" >&2
            echo "client and page are AUTO-INJECTED - remove these lines from your script:" >&2
            echo "  - const client = await connect();" >&2
            echo "  - const page = await client.page(\"...\");" >&2
            echo "  - await client.disconnect();" >&2
            echo "" >&2
            echo "Just use 'page' and 'client' directly. Use -p flag for page name:" >&2
            echo "  dev-browser.sh -p admin --run myscript.ts" >&2
            echo "================================================" >&2
            return 1
        fi

        # Non-recoverable error or max retries reached
        echo "$output"
        return $exit_code
    done
}
