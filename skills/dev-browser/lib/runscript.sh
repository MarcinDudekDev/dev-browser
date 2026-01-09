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
const __pageName = (name: string) => __PROJECT_PREFIX + "-" + name;

// Console message collector
const __consoleMessages: Array<{type: string, text: string}> = [];

// Override client.page to auto-prefix and capture console
const __originalConnect = (await import("@/client.js")).connect;
const connect = async (url?: string) => {
    const client = await __originalConnect(url);
    const originalPage = client.page.bind(client);
    client.page = async (name: string) => {
        const page = await originalPage(__pageName(name));
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

// User script starts here
${SCRIPT}
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

        # Non-recoverable error or max retries reached
        echo "$output"
        return $exit_code
    done
}
