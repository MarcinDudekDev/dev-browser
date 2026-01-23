// Evaluate JavaScript in page context
// Usage: dev-browser.sh eval 'document.title'
// Usage: dev-browser.sh eval 'jQuery("a.btn").trigger("click")'
// Note: 'page' is auto-injected by runscript wrapper
const code = process.env.SCRIPT_ARGS || "";
if (!code) {
    console.error("Usage: dev-browser.sh eval '<javascript>'");
    console.error("Examples:");
    console.error("  eval 'document.title'");
    console.error("  eval 'jQuery(\"a.btn\").trigger(\"click\")'");
    console.error("  eval 'document.querySelector(\".form\").submit()'");
    process.exit(1);
}

try {
    const result = await page.evaluate((js: string) => {
        // Use Function constructor to evaluate arbitrary JS and return result
        try {
            const fn = new Function(`return (${js})`);
            const res = fn();
            // Handle promises (async results)
            if (res && typeof res.then === 'function') {
                return res.then((r: any) => ({ success: true, result: r }));
            }
            return { success: true, result: res };
        } catch {
            // If expression fails, try as statement
            try {
                const fn = new Function(js);
                fn();
                return { success: true, result: undefined };
            } catch (e: any) {
                return { success: false, error: e.message };
            }
        }
    }, code);

    if (result.success) {
        if (result.result !== undefined) {
            console.log(JSON.stringify(result.result, null, 2));
        } else {
            console.log("✓ Executed");
        }
    } else {
        console.error("✗ Error:", result.error);
        process.exit(1);
    }
} catch (e: any) {
    console.error("✗ Failed:", e.message);
    process.exit(1);
}
