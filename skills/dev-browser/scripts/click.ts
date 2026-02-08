// Click element by ref (e5), text, or selector
// Supports --force flag for JS click (bypasses actionability checks)
const forceMode = process.env.FORCE_CLICK === '1';
const target = process.env.SCRIPT_ARGS || "";
if (!target) {
    console.error("Usage: click [--force] <ref|text|selector>");
    console.error("Examples: click e5 | click 'Submit' | click '#btn' | click --force e5");
    console.error("Use --force to bypass overlay/actionability issues (uses JS click)");
    process.exit(1);
}

// Force click helper - dispatches JS events directly
async function forceClickElement(el: any) {
    let handle = el;
    if (typeof el.elementHandle === 'function') {
        handle = await el.elementHandle();
        if (!handle) throw new Error("Could not get element handle");
    }
    await handle.evaluate((node: HTMLElement) => {
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (typeof node.click === 'function') node.click();
    });
}

// Check if target is an ARIA ref (e.g., e1, e5, e123)
const isRef = /^e\d+$/.test(target);

if (isRef) {
    // Click by ARIA snapshot ref
    try {
        const pageName = process.env.PAGE_NAME || "main";
        const prefix = process.env.PROJECT_PREFIX || "dev";
        const element = await client.selectSnapshotRef(`${prefix}-${pageName}`, target);
        if (forceMode) {
            await forceClickElement(element);
        } else {
            await element.click();
        }
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
    // Try as text first, then as selector - search all frames
    let clickedType = "";
    let clicked = false;

    // Try main page first
    try {
        const btn = page.getByRole("button", { name: target });
        if (forceMode) {
            await forceClickElement(btn.first());
        } else {
            await btn.click({ timeout: 3000 });
        }
        clickedType = "button";
        clicked = true;
    } catch {
        try {
            const link = page.getByRole("link", { name: target });
            if (forceMode) {
                await forceClickElement(link.first());
            } else {
                await link.click({ timeout: 3000 });
            }
            clickedType = "link";
            clicked = true;
        } catch {}
    }

    // If not found, search all frames
    if (!clicked) {
        for (const frame of page.frames()) {
            if (clicked) break;
            try {
                const frameBtn = frame.getByRole("button", { name: target });
                if (forceMode) {
                    await forceClickElement(frameBtn.first());
                } else {
                    await frameBtn.click({ timeout: 2000 });
                }
                clickedType = "button (frame)";
                clicked = true;
            } catch {
                try {
                    const frameLink = frame.getByRole("link", { name: target });
                    if (forceMode) {
                        await forceClickElement(frameLink.first());
                    } else {
                        await frameLink.click({ timeout: 2000 });
                    }
                    clickedType = "link (frame)";
                    clicked = true;
                } catch {}
            }
        }
    }

    // Last resort: selector on main page (5s timeout to avoid hanging)
    if (!clicked) {
        const loc = page.locator(target).first();
        if (forceMode) {
            await forceClickElement(loc);
        } else {
            await loc.click({ timeout: 5000 });
        }
        clickedType = "selector";
    }
    await waitForPageLoad(page);
    // Compact output
    const info = await page.evaluate(() => ({
        buttons: [...document.querySelectorAll('button')].slice(0,5).map(b => b.textContent?.trim()).filter(Boolean),
        links: [...document.querySelectorAll('a')].slice(0,5).map(a => a.textContent?.trim()).filter(Boolean)
    }));
    console.log(JSON.stringify({ clicked: target, type: clickedType, url: page.url(), next: info }));
}
