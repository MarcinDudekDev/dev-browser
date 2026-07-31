// Extract patterns from page content
// Usage: dev-browser.sh extract '<regex>'
// Examples: extract '[A-Z0-9]{6}' | extract 'order-\d+' | extract 'https?://[^\s]+'
const pattern = process.env.SCRIPT_ARGS || "";

if (!pattern) {
    console.error("Usage: extract '<regex>'");
    console.error("Examples:");
    console.error("  extract '[A-Z0-9]{6}'        # 6-char codes");
    console.error("  extract 'order-\\d+'          # Order IDs");
    console.error("  extract 'https?://[^\\s]+'    # URLs");
    console.error("  extract '\\d{3}-\\d{4}'        # Phone patterns");
    process.exit(1);
}

try {
    const regex = new RegExp(pattern, 'g');

    // Extract from visible text
    const text = await page.evaluate(() => document.body.innerText);
    const textMatches = text.match(regex) || [];

    // Also check innerHTML for hidden codes (data attributes, hidden inputs, etc.)
    const html = await page.evaluate(() => document.body.innerHTML);
    const htmlMatches = html.match(regex) || [];

    // Check specific likely locations for codes
    const specialMatches = await page.evaluate((pat: string) => {
        const re = new RegExp(pat, 'g');
        const matches: string[] = [];

        // Check input values
        document.querySelectorAll('input').forEach(input => {
            const val = input.value;
            const m = val.match(re);
            if (m) matches.push(...m);
        });

        // Check data attributes
        document.querySelectorAll('[data-code], [data-id], [data-value], [data-key]').forEach(el => {
            for (const attr of el.attributes) {
                if (attr.name.startsWith('data-')) {
                    const m = attr.value.match(re);
                    if (m) matches.push(...m);
                }
            }
        });

        // Check clipboard/copy elements
        document.querySelectorAll('[class*="copy"], [class*="code"], [class*="key"], [class*="token"]').forEach(el => {
            const m = el.textContent?.match(re);
            if (m) matches.push(...m);
        });

        return matches;
    }, pattern);

    // Combine and dedupe
    const unique = [...new Set([...textMatches, ...htmlMatches, ...specialMatches])];

    console.log(JSON.stringify({
        pattern,
        matches: unique,
        count: unique.length,
        source: {
            text: textMatches.length,
            html: htmlMatches.length - textMatches.length,
            special: specialMatches.length
        }
    }, null, 2));
} catch (e: any) {
    console.error(JSON.stringify({ error: `Invalid regex or extraction failed: ${e.message}` }));
    process.exit(1);
}
