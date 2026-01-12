// Click element by ref (e5), text, or selector
const target = process.env.SCRIPT_ARGS || "";
if (!target) {
    console.error("Usage: click <ref|text|selector>");
    console.error("Examples: click e5 | click 'Submit' | click '#btn'");
    process.exit(1);
}

// Check if target is an ARIA ref (e.g., e1, e5, e123)
const isRef = /^e\d+$/.test(target);

if (isRef) {
    // Click by ARIA snapshot ref
    try {
        const pageName = process.env.PAGE_NAME || "main";
        const prefix = process.env.PROJECT_PREFIX || "dev";
        const element = await client.selectSnapshotRef(`${prefix}-${pageName}`, target);
        await element.click();
        await waitForPageLoad(page);
        // Compact output
        const info = await page.evaluate(() => ({
            buttons: [...document.querySelectorAll('button')].slice(0,5).map(b => b.textContent?.trim()).filter(Boolean),
            links: [...document.querySelectorAll('a')].slice(0,5).map(a => a.textContent?.trim()).filter(Boolean)
        }));
        console.log(JSON.stringify({ clicked: target, type: "ref", url: page.url(), next: info }));
    } catch (e: any) {
        console.error(JSON.stringify({ error: `Ref '${target}' not found. Run 'aria' to see available refs.` }));
        process.exit(1);
    }
} else {
    // Try as text first, then as selector
    let clickedType = "";
    try {
        await page.getByRole("button", { name: target }).click();
        clickedType = "button";
    } catch {
        try {
            await page.getByRole("link", { name: target }).click();
            clickedType = "link";
        } catch {
            await page.locator(target).first().click();
            clickedType = "selector";
        }
    }
    await waitForPageLoad(page);
    // Compact output
    const info = await page.evaluate(() => ({
        buttons: [...document.querySelectorAll('button')].slice(0,5).map(b => b.textContent?.trim()).filter(Boolean),
        links: [...document.querySelectorAll('a')].slice(0,5).map(a => a.textContent?.trim()).filter(Boolean)
    }));
    console.log(JSON.stringify({ clicked: target, type: clickedType, url: page.url(), next: info }));
}
