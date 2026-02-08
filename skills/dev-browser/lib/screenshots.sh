#!/bin/bash
# Screenshot commands

cmd_screenshot() {
    local page_name="${1:-main}"
    get_project_paths
    local filename=$(basename "${2:-screenshot-$(date +%s).png}")
    local screenshot_path="$PROJECT_SCREENSHOTS_DIR/$filename"
    start_server || return 1
    local PREFIX=$(get_project_prefix)
    mkdir -p "$PROJECT_SCREENSHOTS_DIR"
    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<SCREENSHOT_SCRIPT
import { connect } from "@/client.js";
const client = await connect("http://localhost:${SERVER_PORT}");
const pages = await client.list();
// Try prefixed name first, then raw name for cross-project access
let pageName = "${PREFIX}-${page_name}";
if (!pages.includes(pageName) && pages.includes("${page_name}")) {
    pageName = "${page_name}";
}
if (!pages.includes(pageName)) {
    console.error("Page '${page_name}' not found (full name: " + pageName + ")");
    console.error("Available pages:");
    pages.forEach(p => console.error("  - " + p));
    await client.disconnect();
    process.exit(1);
}
const page = await client.page(pageName);
console.log("Page URL:", page.url(), "| Target:", pageName);
await page.screenshot({ path: "${screenshot_path}", fullPage: true });
console.log("Screenshot saved:", "${screenshot_path}");
await client.disconnect();
SCREENSHOT_SCRIPT
    resize_screenshot "$screenshot_path"
}

cmd_responsive() {
    local page_name="${1:-main}"
    get_project_paths
    local output_dir="${2:-$PROJECT_SCREENSHOTS_DIR}"
    start_server || return 1
    local PREFIX=$(get_project_prefix)
    mkdir -p "$output_dir"
    local timestamp=$(date +%Y%m%d-%H%M%S)

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<RESPONSIVE_SCRIPT
import { connect } from "@/client.js";

const breakpoints = [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'laptop', width: 1024, height: 768 },
    { name: 'desktop', width: 1280, height: 800 },
];

const client = await connect("http://localhost:${SERVER_PORT}");
const pages = await client.list();
let pageName = "${PREFIX}-${page_name}";
if (!pages.includes(pageName) && pages.includes("${page_name}")) {
    pageName = "${page_name}";
}
if (!pages.includes(pageName)) {
    console.error("Page '${page_name}' not found");
    console.error("Available pages:", pages.join(", "));
    await client.disconnect();
    process.exit(1);
}

const page = await client.page(pageName);
console.log("Taking responsive screenshots of:", page.url());

for (const bp of breakpoints) {
    await page.setViewportSize({ width: bp.width, height: bp.height });
    await page.waitForTimeout(300);
    const hasOverflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    const status = hasOverflow ? '❌ OVERFLOW' : '✅ OK';
    const path = "${output_dir}/${timestamp}-${page_name}-" + bp.name + ".png";
    await page.screenshot({ path, fullPage: true });
    console.log(\`\${bp.name.padEnd(8)} (\${bp.width}px): \${status} → \${path}\`);
}
await page.setViewportSize({ width: 1280, height: 800 });
console.log("\\nViewport reset to desktop (1280x800)");
await client.disconnect();
RESPONSIVE_SCRIPT
}

cmd_resize() {
    local width="$1"
    local height="${2:-900}"
    local page_name="${3:-main}"

    if [[ -z "$width" ]]; then
        echo "Usage: dev-browser.sh --resize <width|WIDTHxHEIGHT> [height] [page]" >&2
        echo "  Common widths: 375 (mobile), 768 (tablet), 1024 (laptop), 1280 (desktop)" >&2
        echo "  Examples: --resize 1440x900  or  --resize 1440 900" >&2
        return 1
    fi

    # Parse WIDTHxHEIGHT format (e.g. 1440x900)
    if [[ "$width" =~ ^([0-9]+)x([0-9]+)$ ]]; then
        height="${BASH_REMATCH[2]}"
        width="${BASH_REMATCH[1]}"
        page_name="${2:-main}"
    fi

    # Check if height is actually a page name
    if [[ ! "$height" =~ ^[0-9]+$ ]]; then
        page_name="$height"
        height=900
    fi

    start_server || return 1
    local PREFIX=$(get_project_prefix)

    # Use server-side resize endpoint so the server's Page object stays in sync
    # (client-side setViewportSize via CDP doesn't update the server's cached state)
    local full_name="${PREFIX}-${page_name}"
    local target_name="$full_name"

    # Check which page name exists
    local pages_json
    pages_json=$(curl -s "http://localhost:${SERVER_PORT}/pages")
    if ! echo "$pages_json" | python3 -c "import sys,json; pages=json.load(sys.stdin)['pages']; sys.exit(0 if '${full_name}' in pages else 1)" 2>/dev/null; then
        if echo "$pages_json" | python3 -c "import sys,json; pages=json.load(sys.stdin)['pages']; sys.exit(0 if '${page_name}' in pages else 1)" 2>/dev/null; then
            target_name="$page_name"
        else
            echo "Page '${page_name}' not found (full name: ${full_name})" >&2
            echo "Available pages:" >&2
            echo "$pages_json" | python3 -c "import sys,json; [print('  -',p) for p in json.load(sys.stdin)['pages']]" 2>/dev/null
            return 1
        fi
    fi

    local result
    result=$(curl -s -X POST "http://localhost:${SERVER_PORT}/pages/$(python3 -c "import urllib.parse; print(urllib.parse.quote('${target_name}'))")/resize" \
        -H "Content-Type: application/json" \
        -d "{\"width\":${width},\"height\":${height}}")

    if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)" 2>/dev/null; then
        echo "Viewport resized to ${width}x${height}"
    else
        echo "Resize failed: $result" >&2
        return 1
    fi
}
