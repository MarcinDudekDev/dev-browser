// Click element by text or selector
import { discoverElements, printDiscovery } from "@/discover.js";

const target = process.env.SCRIPT_ARGS || "";
if (!target) {
    console.error("Usage: dev-browser.sh --run click '<button text>' or 'selector'");
    process.exit(1);
}

const client = await connect();
const page = await client.page("main");

// Try as text first, then as selector
try {
    await page.getByRole("button", { name: target }).click();
    console.log("Clicked button:", target);
} catch {
    try {
        await page.getByRole("link", { name: target }).click();
        console.log("Clicked link:", target);
    } catch {
        await page.locator(target).first().click();
        console.log("Clicked selector:", target);
    }
}

await waitForPageLoad(page);

// Show what's available now
const elements = await discoverElements(page);
printDiscovery(elements, "After click");

await client.disconnect();
