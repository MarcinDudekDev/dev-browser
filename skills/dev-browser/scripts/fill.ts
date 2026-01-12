// Fill form field by ref (e5), name, or label
// Usage: fill <ref|field> <value>  OR  fill "field=value" (legacy)
const args = process.env.SCRIPT_ARGS || "";
if (!args) {
    console.error("Usage: fill <ref|field> <value>");
    console.error("Examples: fill e5 hello | fill email test@example.com | fill 'name=John'");
    process.exit(1);
}

// Parse args: "e5 hello world" → target="e5", value="hello world"
// Or legacy: "field=value" → target="field", value="value"
let target: string;
let value: string;

if (args.includes("=") && !args.startsWith("e")) {
    // Legacy format: field=value
    const eqIdx = args.indexOf("=");
    target = args.slice(0, eqIdx);
    value = args.slice(eqIdx + 1);
} else {
    // New format: target value (first token = target, rest = value)
    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) {
        console.error("Usage: fill <ref|field> <value>");
        process.exit(1);
    }
    target = args.slice(0, spaceIdx);
    value = args.slice(spaceIdx + 1);
}

// Check if target is an ARIA ref (e.g., e1, e5, e123)
const isRef = /^e\d+$/.test(target);

if (isRef) {
    // Fill by ARIA snapshot ref
    try {
        const pageName = process.env.PAGE_NAME || "main";
        const prefix = process.env.PROJECT_PREFIX || "dev";
        const element = await client.selectSnapshotRef(`${prefix}-${pageName}`, target);
        await element.fill(value);
        console.log(JSON.stringify({ filled: target, value, type: "ref" }));
    } catch (e: any) {
        console.error(JSON.stringify({ error: `Ref '${target}' not found. Run 'aria' to see available refs.` }));
        process.exit(1);
    }
} else {
    // Check if target looks like a CSS selector (contains [ ] # . or starts with tag name)
    const looksLikeSelector = /^[a-z]+\[|^\[|^#|^\./.test(target);

    let filled = false;
    let filledWith = "";

    if (looksLikeSelector) {
        // Use target directly as CSS selector
        try {
            const el = page.locator(target).first();
            if (await el.count() > 0) {
                await el.fill(value);
                filledWith = target;
                filled = true;
            }
        } catch {}
    }

    if (!filled) {
        // Try by name, id, label, placeholder
        const selectors = [
            `[name="${target}"]`,
            `#${target}`,
            `[placeholder*="${target}" i]`,
        ];

        for (const sel of selectors) {
            try {
                const el = page.locator(sel).first();
                if (await el.count() > 0) {
                    await el.fill(value);
                    filledWith = sel;
                    filled = true;
                    break;
                }
            } catch {}
        }
    }

    if (!filled) {
        // Try by label
        try {
            await page.getByLabel(target).fill(value);
            filledWith = `label:${target}`;
            filled = true;
        } catch {}
    }

    if (!filled) {
        console.error(JSON.stringify({ error: `Field '${target}' not found` }));
        process.exit(1);
    }

    console.log(JSON.stringify({ filled: target, value, selector: filledWith }));
}
