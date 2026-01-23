// Select dropdown option by ref (e5), name, or CSS selector
// Usage: select <ref|selector> <value>
// Value can be: option value, visible text, or index (e.g., "index=2")
const args = process.env.SCRIPT_ARGS || "";
if (!args) {
    console.error("Usage: select <ref|selector> <value>");
    console.error("Examples: select e5 blue | select country US | select #size 'index=2'");
    process.exit(1);
}

// Parse args: "e5 blue" → target="e5", value="blue"
const spaceIdx = args.indexOf(" ");
if (spaceIdx === -1) {
    console.error("Usage: select <ref|selector> <value>");
    process.exit(1);
}
const target = args.slice(0, spaceIdx);
const value = args.slice(spaceIdx + 1);

// Build selectOption argument (supports value, label, or index)
let selectArg: string | { index: number } | { label: string } | { value: string };
if (value.startsWith("index=")) {
    selectArg = { index: parseInt(value.slice(6), 10) };
} else if (value.startsWith("label=")) {
    selectArg = { label: value.slice(6) };
} else if (value.startsWith("value=")) {
    selectArg = { value: value.slice(6) };
} else {
    // Default: try as value first, Playwright will also match by label
    selectArg = value;
}

// Check if target is an ARIA ref (e.g., e1, e5, e123)
const isRef = /^e\d+$/.test(target);

if (isRef) {
    // Select by ARIA snapshot ref
    try {
        const pageName = process.env.PAGE_NAME || "main";
        const prefix = process.env.PROJECT_PREFIX || "dev";
        const element = await client.selectSnapshotRef(`${prefix}-${pageName}`, target);
        await element.selectOption(selectArg);
        console.log(JSON.stringify({ selected: target, value, type: "ref" }));
    } catch (e: any) {
        console.error(JSON.stringify({ error: `Ref '${target}' not found. Run 'aria' to see available refs.` }));
        process.exit(1);
    }
} else {
    // Check if target looks like a CSS selector
    const looksLikeSelector = /^[a-z]+\[|^\[|^#|^\./.test(target);

    let selected = false;
    let selectedWith = "";

    if (looksLikeSelector) {
        // Use target directly as CSS selector
        try {
            const el = page.locator(target).first();
            if (await el.count() > 0) {
                await el.selectOption(selectArg);
                selectedWith = target;
                selected = true;
            }
        } catch {}
    }

    if (!selected) {
        // Try by name, id
        const selectors = [
            `select[name="${target}"]`,
            `select#${target}`,
            `[name="${target}"]`,
            `#${target}`,
        ];

        for (const sel of selectors) {
            try {
                const el = page.locator(sel).first();
                if (await el.count() > 0) {
                    await el.selectOption(selectArg);
                    selectedWith = sel;
                    selected = true;
                    break;
                }
            } catch {}
        }
    }

    if (!selected) {
        // Try by label
        try {
            await page.getByLabel(target).selectOption(selectArg);
            selectedWith = `label:${target}`;
            selected = true;
        } catch {}
    }

    if (!selected) {
        console.error(JSON.stringify({ error: `Select element '${target}' not found` }));
        process.exit(1);
    }

    console.log(JSON.stringify({ selected: target, value, selector: selectedWith }));
}
