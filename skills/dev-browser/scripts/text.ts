// Extract text from element by ref or selector
// Usage: text <ref|selector>
const target = process.env.SCRIPT_ARGS || "";
if (!target) {
    console.error("Usage: text <ref|selector>");
    console.error("Examples: text e5 | text '.title'");
    process.exit(1);
}

const isRef = /^e\d+$/.test(target);
let text: string | null = null;

if (isRef) {
    // Get text by ARIA ref
    try {
        const prefix = process.env.PROJECT_PREFIX || "dev";
        const pageName = process.env.PAGE_NAME || "main";
        const fullPageName = `${prefix}-${pageName}`;
        const element = await client.selectSnapshotRef(fullPageName, target);
        text = await element.textContent();
    } catch (e: any) {
        console.error(`Ref '${target}' not found. Run 'aria' to see available refs.`);
        process.exit(1);
    }
} else {
    // Use as CSS selector
    const el = page.locator(target).first();
    if (await el.count() > 0) {
        text = await el.textContent();
    } else {
        console.error(`Selector '${target}' not found`);
        process.exit(1);
    }
}

// Output raw text (trimmed) - no JSON wrapper for easy piping
console.log(text?.trim() || "");
