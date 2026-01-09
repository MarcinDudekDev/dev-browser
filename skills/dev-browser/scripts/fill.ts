// Fill form field by name/label
// Usage: --run fill "fieldname=value" or "label:value"
import { discoverElements, printDiscovery } from "@/discover.js";

const args = process.env.SCRIPT_ARGS || "";
if (!args) {
    console.error("Usage: dev-browser.sh --run fill 'fieldname=value'");
    process.exit(1);
}

const [field, ...valueParts] = args.split("=");
const value = valueParts.join("="); // Handle values with = in them

const client = await connect();
const page = await client.page("main");

// Try by name, id, label, placeholder
const selectors = [
    `[name="${field}"]`,
    `#${field}`,
    `[placeholder*="${field}" i]`,
];

let filled = false;
for (const sel of selectors) {
    try {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
            await el.fill(value);
            console.log(`Filled ${sel} with: ${value}`);
            filled = true;
            break;
        }
    } catch {}
}

if (!filled) {
    // Try by label
    try {
        await page.getByLabel(field).fill(value);
        console.log(`Filled label "${field}" with: ${value}`);
        filled = true;
    } catch {}
}

if (!filled) {
    console.error("Could not find field:", field);
    // Still show what's available for debugging
    const elements = await discoverElements(page);
    printDiscovery(elements, "Available elements");
    await client.disconnect();
    process.exit(1);
}

// Show what's available after filling
const elements = await discoverElements(page);
printDiscovery(elements, "After fill");

await client.disconnect();
