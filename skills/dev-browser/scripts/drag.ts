// Drag and drop between elements
// Usage: dev-browser.sh drag <source> <target>
// Examples: drag e1 e5 | drag '#item1' '#dropzone' | drag 'Drag me' 'Drop here'
const args = (process.env.SCRIPT_ARGS || "").trim().split(/\s+/);
const [source, target] = args;

if (!source || !target) {
    console.error("Usage: drag <source> <target>");
    console.error("Examples:");
    console.error("  drag e1 e5              # ARIA refs");
    console.error("  drag '#item' '#zone'    # CSS selectors");
    console.error("  drag 'Drag me' 'Drop'   # Text content");
    process.exit(1);
}

// First, disable pointer-events on fixed overlays to prevent interference
await page.evaluate(() => {
    document.querySelectorAll('*').forEach(el => {
        const style = getComputedStyle(el);
        if (style.position === 'fixed' && parseInt(style.zIndex || '0') > 100) {
            (el as HTMLElement).style.pointerEvents = 'none';
        }
    });
});

const pageName = process.env.PAGE_NAME || "main";
const prefix = process.env.PROJECT_PREFIX || "dev";

// Resolve element (ARIA ref, CSS selector, or text)
async function resolveElement(spec: string) {
    const isRef = /^e\d+$/.test(spec);
    if (isRef) {
        return await client.selectSnapshotRef(`${prefix}-${pageName}`, spec);
    }
    // CSS selector
    if (/^[#.\[]/.test(spec)) {
        return page.locator(spec).first();
    }
    // Try as text
    const byText = page.getByText(spec, { exact: false }).first();
    if (await byText.count() > 0) {
        return byText;
    }
    throw new Error(`Element not found: ${spec}`);
}

try {
    const sourceEl = await resolveElement(source);
    const targetEl = await resolveElement(target);

    // Use Playwright's built-in dragTo
    await sourceEl.dragTo(targetEl);

    await waitForPageLoad(page);
    console.log(JSON.stringify({ dragged: source, to: target, success: true }));
} catch (e: any) {
    // If dragTo fails, try manual drag with mouse events
    try {
        const sourceEl = await resolveElement(source);
        const targetEl = await resolveElement(target);

        const sourceBox = await sourceEl.boundingBox();
        const targetBox = await targetEl.boundingBox();

        if (!sourceBox || !targetBox) {
            throw new Error("Could not get bounding boxes");
        }

        const sourceCenterX = sourceBox.x + sourceBox.width / 2;
        const sourceCenterY = sourceBox.y + sourceBox.height / 2;
        const targetCenterX = targetBox.x + targetBox.width / 2;
        const targetCenterY = targetBox.y + targetBox.height / 2;

        // Manual drag sequence
        await page.mouse.move(sourceCenterX, sourceCenterY);
        await page.mouse.down();
        await page.mouse.move(targetCenterX, targetCenterY, { steps: 10 });
        await page.mouse.up();

        await waitForPageLoad(page);
        console.log(JSON.stringify({ dragged: source, to: target, success: true, method: "manual" }));
    } catch (fallbackError: any) {
        console.error(JSON.stringify({ error: `Drag failed: ${e.message}. Fallback also failed: ${fallbackError.message}` }));
        process.exit(1);
    }
}
