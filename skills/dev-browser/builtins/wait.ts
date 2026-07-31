// Wait for selector or text to appear
import { discoverElements, printDiscovery } from "@/discover.js";

const target = process.env.SCRIPT_ARGS || "";
if (!target) {
    console.error("Usage: dev-browser.sh --run wait 'selector or text'");
    process.exit(1);
}

const client = await connect();
const page = await client.page("main");

try {
    // Try as selector first
    await page.locator(target).first().waitFor({ timeout: 30000 });
    console.log("Found selector:", target);
} catch {
    // Try as text
    await page.getByText(target).first().waitFor({ timeout: 30000 });
    console.log("Found text:", target);
}

// Show what's available after wait
const elements = await discoverElements(page);
printDiscovery(elements, "After wait");

await client.disconnect();
