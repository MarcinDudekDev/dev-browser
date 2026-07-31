// Scroll element into view by CSS selector
const selector = process.env.SCRIPT_ARGS || "";
if (!selector) {
    console.error("Usage: scroll-to <css-selector>");
    console.error("Examples: scroll-to '.faq-section' | scroll-to '#reviews'");
    process.exit(1);
}

const result = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return { error: `Element not found: ${sel}` };
    el.scrollIntoView({ behavior: "instant", block: "start" });
    const rect = el.getBoundingClientRect();
    return { scrolledTo: sel, tag: el.tagName.toLowerCase(), top: Math.round(rect.top), visible: rect.height > 0 };
}, selector);

if ("error" in result) {
    console.error(JSON.stringify(result));
    process.exit(1);
}
console.log(JSON.stringify(result));
