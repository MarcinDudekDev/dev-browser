// JavaScript click - triggers native JS click event via page.evaluate()
// Use when Playwright's click() doesn't trigger JS event handlers
// Usage: jsclick <ref|selector|text>
const target = process.env.SCRIPT_ARGS || "";
if (!target) {
    console.error("Usage: jsclick <ref|selector|text>");
    console.error("Examples: jsclick e5 | jsclick '#submit-btn' | jsclick 'Confirm and Book'");
    console.error("Use when regular 'click' doesn't trigger JS handlers (href='#' links, etc.)");
    process.exit(1);
}

// Check if target is an ARIA ref (e.g., e1, e5, e123)
const isRef = /^e\d+$/.test(target);

async function jsClickElement(el: any) {
    // el may be an ElementHandle (from selectSnapshotRef) or a Locator (from page.locator)
    // ElementHandles have evaluate() directly, Locators have elementHandle() method
    let handle = el;
    if (typeof el.elementHandle === 'function') {
        // It's a Locator - get the ElementHandle
        handle = await el.elementHandle();
        if (!handle) {
            throw new Error("Could not get element handle from locator");
        }
    }
    // Now handle is an ElementHandle - use evaluate directly
    await handle.evaluate((node: HTMLElement) => {
        // Dispatch both click and mousedown/mouseup for maximum compatibility
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        // Also call native click() method
        if (typeof node.click === 'function') {
            node.click();
        }
    });
}

if (isRef) {
    // Click by ARIA snapshot ref
    try {
        const pageName = process.env.PAGE_NAME || "main";
        const prefix = process.env.PROJECT_PREFIX || "dev";
        const element = await client.selectSnapshotRef(`${prefix}-${pageName}`, target);
        await jsClickElement(element);
        await waitForPageLoad(page);
        console.log(JSON.stringify({ jsclicked: target, type: "ref", url: page.url() }));
    } catch (e: any) {
        console.error(JSON.stringify({ error: `Ref '${target}' not found or click failed: ${e.message}` }));
        process.exit(1);
    }
} else {
    // Check if looks like a CSS selector
    const looksLikeSelector = /^[#.\[]/.test(target);
    let clicked = false;
    let clickedType = "";

    if (looksLikeSelector) {
        // Use as CSS selector directly
        try {
            const el = page.locator(target).first();
            if (await el.count() > 0) {
                await jsClickElement(el);
                clickedType = "selector";
                clicked = true;
            }
        } catch {}
    }

    if (!clicked) {
        // Try by text - button first, then link
        try {
            const btn = page.getByRole("button", { name: target });
            if (await btn.count() > 0) {
                await jsClickElement(btn.first());
                clickedType = "button";
                clicked = true;
            }
        } catch {}

        if (!clicked) {
            try {
                const link = page.getByRole("link", { name: target });
                if (await link.count() > 0) {
                    await jsClickElement(link.first());
                    clickedType = "link";
                    clicked = true;
                }
            } catch {}
        }
    }

    if (!clicked) {
        // Last resort: try text selector
        try {
            const el = page.locator(`text="${target}"`).first();
            if (await el.count() > 0) {
                await jsClickElement(el);
                clickedType = "text";
                clicked = true;
            }
        } catch {}
    }

    if (!clicked) {
        console.error(JSON.stringify({ error: `Element '${target}' not found` }));
        process.exit(1);
    }

    await waitForPageLoad(page);
    console.log(JSON.stringify({ jsclicked: target, type: clickedType, url: page.url() }));
}
