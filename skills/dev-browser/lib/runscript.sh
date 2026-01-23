#!/bin/bash
# Default script execution with auto-recovery

# Check for crash info and notify agent
check_crash_recovery() {
    local sessions_file="$SKILL_TMP_DIR/sessions.json"
    if [[ -f "$sessions_file" ]]; then
        local crashed_at
        crashed_at=$(python3 -c "import json; d=json.load(open('$sessions_file')); print(d.get('crashedAt',''))" 2>/dev/null)
        if [[ -n "$crashed_at" ]]; then
            echo "" >&2
            echo "=== DEV-BROWSER RECOVERY ===" >&2
            echo "Previous session crashed at $crashed_at" >&2
            python3 -c "
import json
d = json.load(open('$sessions_file'))
pages = d.get('lostPages', [])
if pages:
    print('Lost pages that need re-navigation:', file=__import__('sys').stderr)
    for p in pages:
        print(f'  - {p}', file=__import__('sys').stderr)
    print('', file=__import__('sys').stderr)
    print('Chrome may have restored the tabs, but you need to re-register them.', file=__import__('sys').stderr)
    print('Tip: Navigate to your test URL again with page.goto()', file=__import__('sys').stderr)
" 2>/dev/null
            echo "===========================" >&2
            echo "" >&2
            return 0  # crash detected
        fi
    fi
    return 1  # no crash
}

run_script() {
    local script_file="$1"
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

    # Strip boilerplate for backward compatibility with existing scripts
    # Remove: const client = await connect();
    # Remove: const page = await client.page("...");
    # Remove: await client.disconnect();
    SCRIPT=$(echo "$SCRIPT" | sed -E \
        -e '/^[[:space:]]*(const|let|var)[[:space:]]+client[[:space:]]*=[[:space:]]*await[[:space:]]+connect\(\)/d' \
        -e '/^[[:space:]]*(const|let|var)[[:space:]]+page[[:space:]]*=[[:space:]]*await[[:space:]]+client\.page\(/d' \
        -e '/^[[:space:]]*await[[:space:]]+client\.disconnect\(\)/d')

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
