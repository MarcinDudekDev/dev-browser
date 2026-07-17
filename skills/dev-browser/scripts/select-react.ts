// Select option from React custom dropdown/combobox
// Usage: select-react <selector> <option text>
// Works with custom dropdowns that don't use native <select>
const args = process.env.SCRIPT_ARGS || "";
if (!args) {
    console.error("Usage: select-react <selector> <option text>");
    console.error("Examples: select-react '[role=combobox]' 'United States'");
    process.exit(1);
}

const spaceIdx = args.indexOf(" ");
if (spaceIdx === -1) {
    console.error("Usage: select-react <selector> <option text>");
    process.exit(1);
}
const selector = args.slice(0, spaceIdx);
const optionText = args.slice(spaceIdx + 1);

// Click to open dropdown
const combobox = page.locator(selector).first();
try {
    await combobox.click({ timeout: 5000 });
} catch (e: any) {
    if (e.message?.includes("Timeout")) {
        console.error(`select-react failed: Element '${selector}' found but not clickable (hidden, disabled, or covered)`);
    } else {
        console.error(`select-react failed: ${e.message}`);
    }
    process.exit(1);
}
await page.waitForTimeout(300);

// Try multiple strategies to find and click the option
const strategies: Array<{ name: string; fn: () => Promise<boolean> }> = [
    {
        name: "role=option",
        fn: async () => {
            const opt = page.getByRole('option', { name: optionText });
            if (await opt.count() > 0) { await opt.first().click(); return true; }
            return false;
        }
    },
    {
        name: "exact text",
        fn: async () => {
            const opt = page.locator(`text="${optionText}"`).first();
            if (await opt.isVisible()) { await opt.click(); return true; }
            return false;
        }
    },
    {
        name: "contains text",
        fn: async () => {
            const opt = page.locator(`text=${optionText}`).first();
            if (await opt.isVisible()) { await opt.click(); return true; }
            return false;
        }
    },
    {
        name: "li/div option",
        fn: async () => {
            const opt = page.locator(`li:has-text("${optionText}"), div[role="option"]:has-text("${optionText}")`).first();
            if (await opt.isVisible()) { await opt.click(); return true; }
            return false;
        }
    },
    {
        name: "data-value",
        fn: async () => {
            const opt = page.locator(`[data-value="${optionText}"]`).first();
            if (await opt.count() > 0) { await opt.click(); return true; }
            return false;
        }
    }
];

let selected = false;
let usedStrategy = "";

for (const s of strategies) {
    try {
        if (await s.fn()) {
            selected = true;
            usedStrategy = s.name;
            break;
        }
    } catch {}
}

// Fallback: type to filter then Enter
if (!selected) {
    try {
        await combobox.pressSequentially(optionText.slice(0, 15), { delay: 30 });
        await page.waitForTimeout(200);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        selected = true;
        usedStrategy = "type+enter";
    } catch {}
}

if (selected) {
    console.log(JSON.stringify({ selected: optionText, strategy: usedStrategy }));
} else {
    console.error(JSON.stringify({ error: `Could not select '${optionText}' in '${selector}'` }));
    process.exit(1);
}
