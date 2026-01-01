// Hard refresh test
const client = await connect();
const page = await client.page("hard-refresh");

// Clear cache
const cdpSession = await page.context().newCDPSession(page);
await cdpSession.send('Network.clearBrowserCache');
console.log("Cache cleared");

await page.goto("https://fiverr.loc/wp-admin/admin.php?page=wp-multitool-slow-callbacks", { waitUntil: 'networkidle' });
await waitForPageLoad(page);

// Check CSS rules
const rules = await page.evaluate(() => {
    const results = [];
    for (const sheet of document.styleSheets) {
        try {
            if (sheet.href && sheet.href.includes('wp-multitool')) {
                for (const rule of sheet.cssRules) {
                    if (rule.cssText && rule.cssText.includes('scf-auto-fade')) {
                        results.push(rule.cssText.substring(0, 200));
                    }
                }
            }
        } catch (e) {
            results.push('Error: ' + e.message);
        }
    }
    return results;
});
console.log("Animation rules found:", rules.length);
for (const r of rules) {
    console.log("  ", r);
}

await client.disconnect();
