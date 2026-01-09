#!/bin/bash
# Screenshot commands

cmd_screenshot() {
    local page_name="${1:-main}"
    get_project_paths
    local screenshot_path="${2:-$PROJECT_SCREENSHOTS_DIR/screenshot-$(date +%s).png}"
    start_server || return 1
    local PREFIX=$(get_project_prefix)
    mkdir -p "$(dirname "$screenshot_path")"

    cd "$DEV_BROWSER_DIR" && ./node_modules/.bin/tsx <<SCREENSHOT_SCRIPT
import { connect } from "@/client.js";
const client = await connect();
const pageName = "${PREFIX}-${page_name}";
const pages = await client.list();
if (!pages.includes(pageName)) {
    console.error("Page '${page_name}' not found (full name: " + pageName + ")");
    console.error("Available pages:");
    pages.forEach(p => console.error("  - " + p));
    await client.disconnect();
    process.exit(1);
}
const page = await client.page(pageName);
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
        echo "Usage: dev-browser.sh --resize <width> [height] [page]" >&2
        echo "  Common widths: 375 (mobile), 768 (tablet), 1024 (laptop), 1280 (desktop)" >&2
        return 1
    fi

    # Check if height is actually a page name
    if [[ ! "$height" =~ ^[0-9]+$ ]]; then
        page_name="$height"
        height=900
    fi

    start_server || return 1
    local PREFIX=$(get_project_prefix)

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
}
