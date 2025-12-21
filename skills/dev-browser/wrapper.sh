#!/bin/bash
# Dev-browser wrapper - runs scripts with project-prefixed page names
# Usage:
#   wrapper.sh [script.ts]              # Run a script file
#   wrapper.sh <<'EOF' ... EOF          # Run inline script
#   wrapper.sh --server                 # Start server only
#   wrapper.sh --status                 # Check server status
#   wrapper.sh --stop                   # Stop server
#   wrapper.sh --inspect [page]         # Inspect page: forms, iframes, errors
#   wrapper.sh --page-status [page]     # Detect error/success messages in DOM
#   wrapper.sh --screenshot [page] [path] # Take screenshot (auto-resizes for Claude)
#   wrapper.sh --console [page]         # Watch console output (Ctrl+C to stop)
#
# Page names are auto-prefixed with project name from cwd.
# Multiple sessions can share the server safely.
#
# Installation:
#   ln -sf "$(pwd)/wrapper.sh" ~/Tools/dev-browser.sh

# Get the directory where this script lives (the skill directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_BROWSER_DIR="$SCRIPT_DIR"

# Screenshot settings (Claude's 8000px limit, leave margin)
MAX_SCREENSHOT_DIM=7500
SERVER_PID_FILE="/tmp/dev-browser-server.pid"
SERVER_LOG="/tmp/dev-browser-server.log"
SERVER_PORT=9222
SCREENSHOTS_DIR="${SCREENSHOTS_DIR:-$HOME/Tools/screenshots}"

get_project_prefix() {
    local cwd="$PWD"

    # Try to get project name from 'p' tool registry
    if [[ -f "$HOME/.claude/projects.json" ]]; then
        local prefix
        prefix=$(python3 -c "
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
else:
    print(os.path.basename(cwd).lower().replace(' ', '-')[:20], end='')
")
        if [[ -n "$prefix" ]]; then
            printf '%s' "$prefix"
            return
        fi
    fi

    # Fallback to directory name
    basename "$cwd" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-20 | tr -d '\n'
}

start_server() {
    # Check if already running
    if curl -s "http://localhost:$SERVER_PORT" &>/dev/null; then
        echo "Server already running on port $SERVER_PORT" >&2
        return 0
    fi

    echo "Starting dev-browser server..." >&2
    cd "$DEV_BROWSER_DIR" || exit 1

    # Start server in background
    nohup ./server.sh > "$SERVER_LOG" 2>&1 &
    local pid=$!
    echo $pid > "$SERVER_PID_FILE"

    # Wait for server to be ready (max 30s)
    local count=0
    while ! curl -s "http://localhost:$SERVER_PORT" &>/dev/null; do
        sleep 1
        count=$((count + 1))
        if [[ $count -ge 30 ]]; then
            echo "Server failed to start. Check $SERVER_LOG" >&2
            return 1
        fi
    done

    echo "Server ready on port $SERVER_PORT" >&2
    return 0
}

stop_server() {
    if [[ -f "$SERVER_PID_FILE" ]]; then
        local pid=$(cat "$SERVER_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping server (PID $pid)..." >&2
            kill "$pid" 2>/dev/null
            rm -f "$SERVER_PID_FILE"
        fi
    fi
    # Also kill any orphaned processes
    pkill -f "start-server.ts" 2>/dev/null
    echo "Server stopped" >&2
}

server_status() {
    if curl -s "http://localhost:$SERVER_PORT" &>/dev/null; then
        echo "Server running on port $SERVER_PORT"
        curl -s "http://localhost:$SERVER_PORT/pages" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Active pages: {len(d.get(\"pages\",[]))}'); [print(f'  - {p}') for p in d.get('pages',[])]" 2>/dev/null
    else
        echo "Server not running"
    fi
}

# Resize screenshot if exceeds Claude's limit (uses sips - macOS built-in)
resize_screenshot() {
    local img="$1"
    [[ ! -f "$img" ]] && return

    # Try sips (macOS)
    if command -v sips &>/dev/null; then
        local width=$(sips -g pixelWidth "$img" 2>/dev/null | tail -1 | awk '{print $2}')
        local height=$(sips -g pixelHeight "$img" 2>/dev/null | tail -1 | awk '{print $2}')
        if [[ "$width" -gt "$MAX_SCREENSHOT_DIM" ]] 2>/dev/null || [[ "$height" -gt "$MAX_SCREENSHOT_DIM" ]] 2>/dev/null; then
            echo "Resizing screenshot (${width}x${height} -> max ${MAX_SCREENSHOT_DIM}px)..." >&2
            sips --resampleHeightWidthMax "$MAX_SCREENSHOT_DIM" "$img" >/dev/null 2>&1
        fi
    # Try ImageMagick (Linux/cross-platform)
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

# Get page status - detect errors and success messages in DOM
run_page_status() {
    local page_name="${1:-main}"
    start_server || exit 1
    local PREFIX=$(get_project_prefix)

    cd "$DEV_BROWSER_DIR" && npx tsx <<STATUS_SCRIPT
import { connect } from "@/client.js";

const client = await connect();
const pageName = "${PREFIX}-${page_name}";
const pages = await client.list();

if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found");
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);

const status = await page.evaluate(() => {
    const getText = (el) => el?.textContent?.trim()?.substring(0, 200) || '';

    // Error selectors (common patterns)
    const errorSelectors = [
        '.error', '.alert-error', '.alert-danger', '[class*="error"]',
        '.warning', '.alert-warning', '[class*="warning"]',
        '[role="alert"]', '.toast-error', '.notification-error'
    ];

    // Success selectors
    const successSelectors = [
        '.success', '.alert-success', '[class*="success"]',
        '.toast-success', '.notification-success'
    ];

    const errors = [];
    const warnings = [];
    const successes = [];

    errorSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
            const text = getText(el);
            if (text && !errors.includes(text) && !warnings.includes(text)) {
                if (sel.includes('warning')) warnings.push(text);
                else errors.push(text);
            }
        });
    });

    successSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
            const text = getText(el);
            if (text && !successes.includes(text)) successes.push(text);
        });
    });

    return {
        url: window.location.href,
        title: document.title,
        errors: errors.slice(0, 5),
        warnings: warnings.slice(0, 5),
        successes: successes.slice(0, 5)
    };
});

console.log("=== PAGE STATUS: ${page_name} ===");
console.log("URL:", status.url);
console.log("Title:", status.title);

if (status.errors.length > 0) {
    console.log("\\n❌ ERRORS:");
    status.errors.forEach(e => console.log("  ", e));
}
if (status.warnings.length > 0) {
    console.log("\\n⚠️  WARNINGS:");
    status.warnings.forEach(w => console.log("  ", w));
}
if (status.successes.length > 0) {
    console.log("\\n✅ SUCCESS:");
    status.successes.forEach(s => console.log("  ", s));
}
if (status.errors.length === 0 && status.warnings.length === 0 && status.successes.length === 0) {
    console.log("\\n(No status messages detected)");
}

await client.disconnect();
STATUS_SCRIPT
}

# Inspect a page - show forms, iframes, console errors
run_inspect() {
    local page_name="${1:-main}"
    start_server || exit 1
    local PREFIX=$(get_project_prefix)

    cd "$DEV_BROWSER_DIR" && npx tsx <<INSPECT_SCRIPT
import { connect } from "@/client.js";

const client = await connect();
const pageName = "${PREFIX}-${page_name}";

// List available pages
const pages = await client.list();
if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found. Available pages:");
    pages.forEach(p => console.log("  - " + p.replace("${PREFIX}-", "")));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);

console.log("=== PAGE INSPECT: ${page_name} ===");
console.log("URL:", page.url());
console.log("");

const info = await page.evaluate(() => {
    // Forms
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        id: f.id || '(no id)',
        action: f.action || '(no action)',
        fields: Array.from(f.querySelectorAll('input, select, textarea')).slice(0, 10).map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            name: el.name || el.id || '(unnamed)',
            value: el.value?.substring(0, 30) || ''
        }))
    }));

    // Iframes
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
        name: f.name || '(no name)',
        src: f.src?.substring(0, 80) || '(no src)',
        isStripe: f.src?.includes('stripe') || false
    }));

    // Inputs outside forms
    const orphanInputs = Array.from(document.querySelectorAll('input:not(form input), select:not(form select)')).slice(0, 10).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || el.id || '(unnamed)'
    }));

    return { forms, iframes, orphanInputs };
});

if (info.forms.length > 0) {
    console.log("=== FORMS ===");
    info.forms.forEach((f, i) => {
        console.log(\`Form #\${i + 1}: id="\${f.id}" action="\${f.action}"\`);
        f.fields.forEach(field => {
            console.log(\`  [\${field.tag}] name="\${field.name}" type="\${field.type}" value="\${field.value}"\`);
        });
    });
    console.log("");
}

if (info.iframes.length > 0) {
    console.log("=== IFRAMES ===");
    info.iframes.forEach(f => {
        const badge = f.isStripe ? " [STRIPE]" : "";
        console.log(\`  name="\${f.name}"\${badge}\`);
        console.log(\`    src: \${f.src}\`);
    });
    console.log("");
}

if (info.orphanInputs.length > 0) {
    console.log("=== INPUTS (outside forms) ===");
    info.orphanInputs.forEach(field => {
        console.log(\`  [\${field.tag}] name="\${field.name}" type="\${field.type}"\`);
    });
    console.log("");
}

// Get ARIA snapshot summary
const snapshot = await client.getAISnapshot(pageName);
const lines = snapshot.split('\\n');
const buttons = lines.filter(l => l.includes('button')).slice(0, 5);
const links = lines.filter(l => l.includes('link "')).slice(0, 5);
const textboxes = lines.filter(l => l.includes('textbox')).slice(0, 5);

console.log("=== KEY ELEMENTS (from ARIA snapshot) ===");
if (buttons.length) { console.log("Buttons:"); buttons.forEach(b => console.log("  " + b.trim())); }
if (textboxes.length) { console.log("Textboxes:"); textboxes.forEach(t => console.log("  " + t.trim())); }
console.log("");

await client.disconnect();
INSPECT_SCRIPT
}

# Watch console output from a page
run_console() {
    local page_name="${1:-main}"
    start_server || exit 1
    local PREFIX=$(get_project_prefix)

    echo "Watching console for page '${page_name}' (Ctrl+C to stop)..."

    cd "$DEV_BROWSER_DIR" && npx tsx <<CONSOLE_SCRIPT
import { connect } from "@/client.js";

const client = await connect();
const page = await client.page("${PREFIX}-${page_name}");

page.on('console', msg => {
    const type = msg.type().toUpperCase().padEnd(7);
    const text = msg.text();
    const time = new Date().toLocaleTimeString();
    console.log(\`[\${time}] \${type} \${text}\`);
});

page.on('pageerror', err => {
    const time = new Date().toLocaleTimeString();
    console.log(\`[\${time}] ERROR   \${err.message}\`);
});

console.log("Listening for console messages...");
console.log("URL:", page.url());
console.log("---");

// Keep alive
await new Promise(() => {});
CONSOLE_SCRIPT
}

# Handle flags
case "$1" in
    --server)
        start_server
        exit $?
        ;;
    --stop)
        stop_server
        exit 0
        ;;
    --status)
        server_status
        exit 0
        ;;
    --inspect)
        run_inspect "$2"
        exit $?
        ;;
    --console)
        run_console "$2"
        exit $?
        ;;
    --page-status)
        run_page_status "$2"
        exit $?
        ;;
    --screenshot)
        page_name="${2:-main}"
        screenshot_path="${3:-$SCREENSHOTS_DIR/screenshot-$(date +%s).png}"
        start_server || exit 1
        PREFIX=$(get_project_prefix)
        mkdir -p "$(dirname "$screenshot_path")"
        cd "$DEV_BROWSER_DIR" && npx tsx <<SCREENSHOT_SCRIPT
import { connect } from "@/client.js";
const client = await connect();
const page = await client.page("${PREFIX}-${page_name}");
await page.screenshot({ path: "${screenshot_path}", fullPage: true });
console.log("Screenshot saved:", "${screenshot_path}");
await client.disconnect();
SCREENSHOT_SCRIPT
        resize_screenshot "$screenshot_path"
        exit $?
        ;;
    --help|-h)
        head -19 "$0" | tail -17
        exit 0
        ;;
esac

# Ensure server is running
start_server || exit 1

# Get project prefix for page names (no newline)
PREFIX=$(get_project_prefix)

# Read script from file or stdin
if [[ -n "$1" && -f "$1" ]]; then
    SCRIPT=$(cat "$1")
else
    SCRIPT=$(cat)
fi

# Create temp script file with .mts extension for ESM support
TEMP_SCRIPT=$(mktemp /tmp/dev-browser-XXXXXX)
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
const { waitForPageLoad } = await import("@/client.js");

// User script starts here
${SCRIPT}
ENDOFSCRIPT

cd "$DEV_BROWSER_DIR" && exec npx tsx "$TEMP_SCRIPT"
