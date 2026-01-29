#!/bin/bash
# Default script execution with auto-recovery

# Check for crash info and notify agent
check_crash_recovery() {
    local sessions_file="$SKILL_TMP_DIR/sessions.json"
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
    export SERVER_PORT PAGE_NAME
    bash "$shell_script"
}

run_script() {
    local script_file="$1"

    # Fast path: check for .sh companion script (server-side, no tsx)
    if [[ -n "$script_file" && -f "$script_file" ]]; then
        local shell_companion="${script_file%.ts}.sh"
        if [[ -f "$shell_companion" ]]; then
            run_script_fast "$shell_companion"
            local fast_exit=$?
            # Exit 99 = ARIA ref or feature needing tsx; fall through
            [[ $fast_exit -ne 99 ]] && return $fast_exit
        fi
    fi

    local PREFIX=$(get_project_prefix)
    local SCRIPT=""
    local MAX_RETRIES=1
    local retry_count=0

    # Read script from file or stdin
    if [[ -n "$script_file" && -f "$script_file" ]]; then
        SCRIPT=$(cat "$script_file")
    else
        SCRIPT=$(cat)
    fi

    # Strip boilerplate for backward compatibility with user scripts (not builtins)
    if [[ -n "$script_file" && "$script_file" != *"/scripts/"* ]]; then
        SCRIPT=$(echo "$SCRIPT" | sed -E \
            -e '/^[[:space:]]*(const|let|var)[[:space:]]+client[[:space:]]*=[[:space:]]*await[[:space:]]+connect\(\)/d' \
            -e '/^[[:space:]]*(const|let|var)[[:space:]]+page[[:space:]]*=[[:space:]]*await[[:space:]]+client\.page\(/d' \
            -e '/^[[:space:]]*await[[:space:]]+client\.disconnect\(\)/d')
    fi

    # Create temp script file with .mts extension for ESM support
    get_project_paths  # sets PROJECT_TMP_DIR
    local TEMP_SCRIPT
    TEMP_SCRIPT=$(mktemp "$PROJECT_TMP_DIR/script-XXXXXX")
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
        output=$(./node_modules/.bin/tsx "$TEMP_SCRIPT" 2>&1)
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

                # Stop and restart server
                stop_server 2>/dev/null
                sleep 1
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
