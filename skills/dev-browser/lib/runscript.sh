#!/bin/bash
# Default script execution

run_script() {
    local script_file="$1"
    local PREFIX=$(get_project_prefix)
    local SCRIPT=""

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

    cd "$DEV_BROWSER_DIR" && exec ./node_modules/.bin/tsx "$TEMP_SCRIPT"
}
