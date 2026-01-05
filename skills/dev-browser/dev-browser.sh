#!/bin/bash
# Dev-browser wrapper - runs scripts with project-prefixed page names
# Usage:
#   dev-browser.sh [script.ts]              # Run a script file
#   dev-browser.sh <<'EOF' ... EOF          # Run inline script (or pipe)
#   dev-browser.sh --run <name> [args]      # Run named script from scripts dir
#   dev-browser.sh --list                   # List available scripts
#   dev-browser.sh --scenario <file.yaml>   # Run YAML scenario file
#   dev-browser.sh --scenarios              # List available scenario files
#   dev-browser.sh --server                 # Start server only
#   dev-browser.sh --status                 # Check server status
#   dev-browser.sh --stop                   # Stop server
#   dev-browser.sh --inspect [page]         # Inspect page: forms, iframes, errors
#   dev-browser.sh --page-status [page]     # Detect error/success messages in DOM
#   dev-browser.sh --screenshot [page] [path] # Take screenshot (auto-resizes)
#   dev-browser.sh --console [page] [timeout]  # Watch console (timeout in seconds, 0=forever)
#   dev-browser.sh --snap [page]              # Save baseline screenshot for visual diff
#   dev-browser.sh --diff [page]              # Compare current state to baseline
#   dev-browser.sh --baselines                # List saved visual baselines
#   dev-browser.sh --resize <width> [h] [page] # Resize viewport (375/768/1024/1280)
#   dev-browser.sh --responsive [page] [dir]  # Screenshots at all breakpoints
#   dev-browser.sh --wplogin [url]            # Auto-login to WordPress (admin/admin123)
#                                             # Auto-detects domain from wp-test cwd
#
# Page names are auto-prefixed with project name from cwd.
# WP-TEST CREDENTIALS: admin / admin123 (lowercase)
# Scripts dir: ~/Tools/dev-browser-scripts/
#
# Installation:
#   ln -sf "$(pwd)/wrapper.sh" ~/Tools/dev-browser.sh

# Get the directory where this script lives (following symlinks)
SOURCE="${BASH_SOURCE[0]}"
if [ -L "$SOURCE" ]; then
    SOURCE="$(readlink "$SOURCE")"
fi
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
DEV_BROWSER_DIR="$SCRIPT_DIR"

# Skill-local tmp directory (avoids /tmp permission prompts)
SKILL_TMP_DIR="$DEV_BROWSER_DIR/tmp"
mkdir -p "$SKILL_TMP_DIR"

# Screenshot settings (Claude's 8000px limit, leave margin)
MAX_SCREENSHOT_DIM=7500
SERVER_PID_FILE="$SKILL_TMP_DIR/server.pid"
SERVER_LOG="$SKILL_TMP_DIR/server.log"
SERVER_PORT=9222
SCREENSHOTS_DIR="${SCREENSHOTS_DIR:-$HOME/Tools/screenshots}"
# Built-in scripts (bundled with skill)
BUILTIN_SCRIPTS_DIR="$DEV_BROWSER_DIR/scripts"
# User scripts (personal/project-specific)
USER_SCRIPTS_DIR="$HOME/Tools/dev-browser-scripts"
VISUAL_DIFF="$HOME/Tools/visual-diff"

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

# Get per-project paths for screenshots and temp scripts
get_project_paths() {
    local prefix=$(get_project_prefix)
    PROJECT_SCREENSHOTS_DIR="$SCREENSHOTS_DIR/$prefix"
    PROJECT_TMP_DIR="$SKILL_TMP_DIR/$prefix"
    mkdir -p "$PROJECT_TMP_DIR" "$PROJECT_SCREENSHOTS_DIR"
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

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<STATUS_SCRIPT
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

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<INSPECT_SCRIPT
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

console.log("=== KEY ELEMENTS (use [ref=eN] with selectSnapshotRef) ===");
if (buttons.length) { console.log("Buttons:"); buttons.forEach(b => console.log("  " + b.trim())); }
if (links.length) { console.log("Links:"); links.forEach(l => console.log("  " + l.trim())); }
if (textboxes.length) { console.log("Textboxes:"); textboxes.forEach(t => console.log("  " + t.trim())); }
console.log("");

await client.disconnect();
INSPECT_SCRIPT
}

# Watch console output from a page
run_console() {
    local page_name="${1:-main}"
    local timeout_sec="${2:-0}"
    start_server || exit 1
    local PREFIX=$(get_project_prefix)

    if [[ "$timeout_sec" -gt 0 ]]; then
        echo "Watching console for page '${page_name}' (timeout: ${timeout_sec}s)..."
    else
        echo "Watching console for page '${page_name}' (Ctrl+C to stop)..."
    fi

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<CONSOLE_SCRIPT
import { connect } from "@/client.js";

const client = await connect();
const pageName = "${PREFIX}-${page_name}";
const timeoutSec = ${timeout_sec};

// Check if page exists first
const pages = await client.list();
if (!pages.includes(pageName)) {
    console.log("Page '${page_name}' not found. Available pages:");
    pages.forEach(p => console.log("  - " + p.replace("${PREFIX}-", "")));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);

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

if (timeoutSec > 0) {
    // Exit after timeout
    setTimeout(async () => {
        console.log("---");
        console.log(\`Timeout (\${timeoutSec}s) reached.\`);
        await client.disconnect();
        process.exit(0);
    }, timeoutSec * 1000);
} else {
    // Keep alive forever
    await new Promise(() => {});
}
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
        # --console [page] [timeout_seconds]
        run_console "$2" "$3"
        exit $?
        ;;
    --page-status)
        run_page_status "$2"
        exit $?
        ;;
    --screenshot)
        page_name="${2:-main}"
        get_project_paths  # sets PROJECT_SCREENSHOTS_DIR
        screenshot_path="${3:-$PROJECT_SCREENSHOTS_DIR/screenshot-$(date +%s).png}"
        start_server || exit 1
        PREFIX=$(get_project_prefix)
        mkdir -p "$(dirname "$screenshot_path")"
        cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<SCREENSHOT_SCRIPT
import { connect } from "@/client.js";
const client = await connect();
const pageName = "${PREFIX}-${page_name}";

// Check if page exists first - don't create new empty tabs
const pages = await client.list();
if (!pages.includes(pageName)) {
    console.error("Page '${page_name}' not found (full name: " + pageName + ")");
    console.error("Available pages:");
    pages.forEach(p => console.error("  - " + p));
    await client.disconnect();
    process.exit(1);
}

// Page exists, safe to get it (won't create new)
const page = await client.page(pageName);
await page.screenshot({ path: "${screenshot_path}", fullPage: true });
console.log("Screenshot saved:", "${screenshot_path}");
await client.disconnect();
SCREENSHOT_SCRIPT
        resize_screenshot "$screenshot_path"
        exit $?
        ;;
    --snap)
        # Save baseline screenshot for visual diff
        page_name="${2:-main}"
        "$VISUAL_DIFF" --snap "$page_name"
        exit $?
        ;;
    --diff)
        # Compare current state to baseline
        page_name="${2:-main}"
        "$VISUAL_DIFF" --compare "$page_name"
        exit $?
        ;;
    --baselines)
        # List saved baselines
        "$VISUAL_DIFF" --list
        exit $?
        ;;
    --resize)
        # Resize viewport: --resize <width> [height] [page]
        width="${2:-}"
        if [[ -z "$width" ]]; then
            echo "Usage: dev-browser.sh --resize <width> [height] [page]" >&2
            echo "  Common widths: 375 (mobile), 768 (tablet), 1024 (laptop), 1280 (desktop)" >&2
            exit 1
        fi
        height="${3:-900}"
        page_name="${4:-main}"
        # Check if height is actually a page name (no third arg)
        if [[ ! "$height" =~ ^[0-9]+$ ]]; then
            page_name="$height"
            height=900
        fi
        start_server || exit 1
        PREFIX=$(get_project_prefix)
        cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<RESIZE_SCRIPT
import { connect } from "@/client.js";
const client = await connect();
const pageName = "${PREFIX}-${page_name}";
const pages = await client.list();
if (!pages.includes(pageName)) {
    console.error("Page '${page_name}' not found");
    console.error("Available pages:", pages.join(", "));
    await client.disconnect();
    process.exit(1);
}
const page = await client.page(pageName);
await page.setViewportSize({ width: ${width}, height: ${height} });
console.log("Viewport resized to ${width}x${height}");
await client.disconnect();
RESIZE_SCRIPT
        exit $?
        ;;
    --responsive)
        # Take screenshots at common breakpoints: --responsive [page] [output_dir]
        page_name="${2:-main}"
        get_project_paths  # sets PROJECT_SCREENSHOTS_DIR
        output_dir="${3:-$PROJECT_SCREENSHOTS_DIR}"
        start_server || exit 1
        PREFIX=$(get_project_prefix)
        mkdir -p "$output_dir"
        timestamp=$(date +%Y%m%d-%H%M%S)
        cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<RESPONSIVE_SCRIPT
import { connect } from "@/client.js";

const breakpoints = [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'laptop', width: 1024, height: 768 },
    { name: 'desktop', width: 1280, height: 800 },
];

const client = await connect();
const pageName = "${PREFIX}-${page_name}";
const pages = await client.list();
if (!pages.includes(pageName)) {
    console.error("Page '${page_name}' not found");
    console.error("Available pages:", pages.join(", "));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);
const url = page.url();
console.log("Taking responsive screenshots of:", url);

for (const bp of breakpoints) {
    await page.setViewportSize({ width: bp.width, height: bp.height });
    await page.waitForTimeout(300); // Let CSS settle

    // Check for horizontal overflow
    const hasOverflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth
    );

    const status = hasOverflow ? '❌ OVERFLOW' : '✅ OK';
    const path = "${output_dir}/${timestamp}-${page_name}-" + bp.name + ".png";
    await page.screenshot({ path, fullPage: true });
    console.log(\`\${bp.name.padEnd(8)} (\${bp.width}px): \${status} → \${path}\`);
}

// Reset to desktop
await page.setViewportSize({ width: 1280, height: 800 });
console.log("\\nViewport reset to desktop (1280x800)");
await client.disconnect();
RESPONSIVE_SCRIPT
        exit $?
        ;;
    --help|-h)
        head -27 "$0" | tail -25
        exit 0
        ;;
    --scenarios)
        # List available scenario files
        echo "=== Available scenarios ($DEV_BROWSER_DIR/scenarios/examples/) ==="
        if [[ -d "$DEV_BROWSER_DIR/scenarios/examples" ]]; then
            find "$DEV_BROWSER_DIR/scenarios/examples" -name "*.yaml" -o -name "*.yml" 2>/dev/null | sort | while read f; do
                name=$(basename "$f")
                desc=$(grep "^description:" "$f" 2>/dev/null | head -1 | sed 's/^description: *//' | sed 's/^["\x27]//' | sed 's/["\x27]$//')
                [[ -z "$desc" ]] && desc="(no description)"
                printf "  %-30s %s\n" "$name" "$desc"
            done
        else
            echo "  No scenarios directory found"
        fi
        exit 0
        ;;
    --scenario)
        # Run YAML scenario file
        scenario_file="${2:-}"
        if [[ -z "$scenario_file" ]]; then
            echo "Usage: dev-browser.sh --scenario <file.yaml>" >&2
            echo "" >&2
            echo "Available scenarios (use --scenarios to list):" >&2
            find "$DEV_BROWSER_DIR/scenarios/examples" -name "*.yaml" -o -name "*.yml" 2>/dev/null | head -5 | xargs -I{} basename {} | sed 's/^/  /'
            exit 1
        fi
        # Check if file exists as-is, or in examples dir
        if [[ -f "$scenario_file" ]]; then
            SCENARIO_PATH="$scenario_file"
        elif [[ -f "$DEV_BROWSER_DIR/scenarios/examples/$scenario_file" ]]; then
            SCENARIO_PATH="$DEV_BROWSER_DIR/scenarios/examples/$scenario_file"
        else
            echo "Scenario file not found: $scenario_file" >&2
            echo "Searched:" >&2
            echo "  $scenario_file" >&2
            echo "  $DEV_BROWSER_DIR/scenarios/examples/$scenario_file" >&2
            exit 1
        fi
        start_server || exit 1
        cd "$DEV_BROWSER_DIR" && exec bun x tsx src/scenario-runner.ts "$SCENARIO_PATH"
        ;;
    --wplogin)
        # WordPress login: navigate, fill credentials, submit
        # Auto-detect domain from cwd if in a wp-test site directory
        target_url="${2:-}"
        if [[ -z "$target_url" ]]; then
            # Try to extract domain from cwd path like ~/.wp-test/sites/<domain>/
            if [[ "$PWD" == *"/.wp-test/sites/"* ]]; then
                wp_domain=$(echo "$PWD" | sed -n 's|.*/.wp-test/sites/\([^/]*\)/.*|\1|p')
                if [[ -n "$wp_domain" ]]; then
                    target_url="https://${wp_domain}/wp-admin/"
                    echo "Auto-detected wp-test domain: ${wp_domain}" >&2
                fi
            fi
        fi
        # Final fallback - should not happen with proper detection
        if [[ -z "$target_url" ]]; then
            echo "ERROR: Could not detect WordPress URL. Please provide URL as argument:" >&2
            echo "  dev-browser.sh --wplogin https://mysite.local/wp-admin/" >&2
            exit 1
        fi
        start_server || exit 1
        PREFIX=$(get_project_prefix)
        cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<WPLOGIN_SCRIPT
import { connect, waitForPageLoad } from "@/client.js";

const targetUrl = "${target_url}";
const username = "admin";
const password = "admin123";

const client = await connect();
const page = await client.page("${PREFIX}-main");

// Navigate to target URL
console.log("Navigating to:", targetUrl);
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
await waitForPageLoad(page);

// Check if we're on login page
const currentUrl = page.url();
if (currentUrl.includes('wp-login.php')) {
    console.log("Login page detected, logging in...");

    // Fill login form
    await page.fill('input[name="log"]', username);
    await page.fill('input[name="pwd"]', password);

    // Click login button and wait for navigation
    await Promise.all([
        page.waitForNavigation({ timeout: 30000 }),
        page.click('input[name="wp-submit"]')
    ]);

    console.log("Logged in successfully!");
} else {
    console.log("Already logged in or not a login page");
}

console.log("Current URL:", page.url());
console.log("Title:", await page.title());
await client.disconnect();
WPLOGIN_SCRIPT
        exit $?
        ;;
    --run)
        # Run a named script from scripts directory
        # Resolution order: builtin → user root → user subdirs
        script_name="$2"
        shift 2
        script_file=""
        # 1. Check builtin scripts (skill/scripts/)
        if [[ -f "$BUILTIN_SCRIPTS_DIR/${script_name}.ts" ]]; then
            script_file="$BUILTIN_SCRIPTS_DIR/${script_name}.ts"
        # 2. Check user scripts root
        elif [[ -f "$USER_SCRIPTS_DIR/${script_name}.ts" ]]; then
            script_file="$USER_SCRIPTS_DIR/${script_name}.ts"
        # 3. Check user scripts with path (project/script)
        elif [[ -f "$USER_SCRIPTS_DIR/${script_name}.ts" ]]; then
            script_file="$USER_SCRIPTS_DIR/${script_name}.ts"
        fi
        if [[ -z "$script_file" ]]; then
            echo "Script not found: $script_name" >&2
            echo "Searched:" >&2
            echo "  $BUILTIN_SCRIPTS_DIR/${script_name}.ts" >&2
            echo "  $USER_SCRIPTS_DIR/${script_name}.ts" >&2
            echo "" >&2
            echo "Built-in scripts:" >&2
            ls -1 "$BUILTIN_SCRIPTS_DIR"/*.ts 2>/dev/null | xargs -I{} basename {} .ts | sed 's/^/  /'
            echo "" >&2
            echo "User scripts (use --list for full list):" >&2
            find "$USER_SCRIPTS_DIR" -maxdepth 2 -name "*.ts" 2>/dev/null | head -10 | sed "s|$USER_SCRIPTS_DIR/||" | sed 's/^/  /'
            exit 1
        fi
        # Pass remaining args as env vars
        export SCRIPT_ARGS="$*"
        exec "$0" "$script_file"
        ;;
    --list)
        # List available scripts
        echo "=== Built-in scripts ($BUILTIN_SCRIPTS_DIR) ==="
        ls -1 "$BUILTIN_SCRIPTS_DIR"/*.ts 2>/dev/null | while read f; do
            [[ "$(basename "$f")" == "start-server.ts" ]] && continue
            name=$(basename "$f" .ts)
            desc=$(head -1 "$f" | sed -n 's|^// *||p')
            [[ -z "$desc" ]] && desc="(no description)"
            printf "  %-20s %s\n" "$name" "$desc"
        done
        echo ""
        echo "=== User scripts ($USER_SCRIPTS_DIR) ==="
        find "$USER_SCRIPTS_DIR" -maxdepth 2 -name "*.ts" 2>/dev/null | sort | while read f; do
            name=$(echo "$f" | sed "s|$USER_SCRIPTS_DIR/||" | sed 's/\.ts$//')
            desc=$(head -1 "$f" | sed -n 's|^// *||p')
            [[ -z "$desc" ]] && desc=""
            printf "  %-30s %s\n" "$name" "$desc"
        done
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
get_project_paths  # sets PROJECT_TMP_DIR
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
