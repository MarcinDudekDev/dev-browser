#!/bin/bash
# WordPress login command

cmd_wplogin() {
    local target_url="$1"

    if [[ -z "$target_url" ]]; then
        # Try to extract domain from cwd path like ~/.wp-test/sites/<domain>/
        if [[ "$PWD" == *"/.wp-test/sites/"* ]]; then
            local wp_domain
            wp_domain=$(echo "$PWD" | sed -n 's|.*/.wp-test/sites/\([^/]*\)/.*|\1|p')
            if [[ -n "$wp_domain" ]]; then
                target_url="https://${wp_domain}/wp-admin/"
                echo "Auto-detected wp-test domain: ${wp_domain}" >&2
            fi
        fi
    fi

    if [[ -z "$target_url" ]]; then
        echo "ERROR: Could not detect WordPress URL. Please provide URL as argument:" >&2
        echo "  dev-browser.sh --wplogin https://mysite.local/wp-admin/" >&2
        return 1
    fi

    start_server || return 1
    local PREFIX=$(get_project_prefix)

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
}
