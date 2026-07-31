// Set slider value by ref, label, role, or selector
// Usage: slide <ref|label|selector> <value>
// Strategy: fill() → positional click → keyboard arrows

const args = process.env.SCRIPT_ARGS || "";
if (!args) {
    console.error("Usage: slide <ref|label|selector> <value>");
    console.error("Examples: slide e123 9 | slide Rating 7 | slide '[role=slider]' 50");
    process.exit(1);
}

const spaceIdx = args.indexOf(" ");
if (spaceIdx === -1) {
    console.error("Usage: slide <target> <value>");
    process.exit(1);
}
const target = args.slice(0, spaceIdx);
const desiredValue = parseFloat(args.slice(spaceIdx + 1));
if (isNaN(desiredValue)) {
    console.error(`Invalid value: ${args.slice(spaceIdx + 1)}`);
    process.exit(1);
}

const isRef = /^e\d+$/.test(target);
const pageName = process.env.PAGE_NAME || "main";
const prefix = process.env.PROJECT_PREFIX || "dev";

// Resolve locator from ref, label, or selector
let locator: any;

if (isRef) {
    try {
        locator = await client.selectSnapshotRef(`${prefix}-${pageName}`, target);
    } catch {
        console.error(JSON.stringify({ error: `Ref '${target}' not found. Run 'aria' to see available refs.` }));
        process.exit(1);
    }
} else {
    // Try role=slider with name, then generic locator
    const byRole = page.getByRole("slider", { name: target });
    if (await byRole.count() > 0) {
        locator = byRole.first();
    } else {
        // Try label text → find associated slider
        const byLabel = page.getByLabel(target);
        if (await byLabel.count() > 0) {
            locator = byLabel.first();
        } else {
            // CSS selector fallback
            locator = page.locator(target).first();
        }
    }
}

// Get element info for slider math
const info = await locator.evaluate((el: HTMLElement) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = el.getAttribute("type");
    const isNativeRange = tag === "input" && type === "range";
    const rect = el.getBoundingClientRect();

    // Gather range attributes from various sources
    const min = parseFloat(el.getAttribute("aria-valuemin") ?? el.getAttribute("min") ?? "0");
    const max = parseFloat(el.getAttribute("aria-valuemax") ?? el.getAttribute("max") ?? "100");
    const now = parseFloat(el.getAttribute("aria-valuenow") ?? (el as HTMLInputElement).value ?? "0");
    const step = parseFloat(el.getAttribute("step") ?? el.getAttribute("data-step") ?? "1");

    // Check for orientation
    const orientation = el.getAttribute("aria-orientation") ||
        (rect.height > rect.width * 2 ? "vertical" : "horizontal");

    return {
        tag, role, type: type ?? "", isNativeRange, orientation,
        min, max, now, step,
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    };
});

const { min, max, now, step, isNativeRange, orientation } = info;
const clampedValue = Math.max(min, Math.min(max, desiredValue));

// Strategy 1: Playwright fill() — works for native <input type="range">
if (isNativeRange) {
    try {
        await locator.fill(String(clampedValue));
        const newVal = await locator.evaluate((el: HTMLInputElement) => el.value);
        console.log(JSON.stringify({ slider: target, value: parseFloat(newVal), method: "fill" }));
        process.exit(0);
    } catch {}
}

// Strategy 2: Positional click — works for most custom sliders
if (info.width > 0 && info.height > 0 && max > min) {
    const ratio = (clampedValue - min) / (max - min);
    let clickX: number, clickY: number;

    if (orientation === "vertical") {
        // Vertical sliders: bottom = min, top = max (usually)
        clickX = info.x + info.width / 2;
        clickY = info.y + info.height * (1 - ratio);
    } else {
        // Horizontal: left = min, right = max
        clickX = info.x + info.width * ratio;
        clickY = info.y + info.height / 2;
    }

    await page.mouse.click(clickX, clickY);
    // Small pause for React/framework state to settle
    await page.waitForTimeout(200);

    // Verify
    const afterClick = await locator.evaluate((el: HTMLElement) => {
        return parseFloat(
            el.getAttribute("aria-valuenow") ??
            (el as HTMLInputElement).value ??
            "NaN"
        );
    });

    if (!isNaN(afterClick) && afterClick === clampedValue) {
        console.log(JSON.stringify({ slider: target, value: afterClick, method: "click" }));
        process.exit(0);
    }

    // If click got us close but not exact, try keyboard fine-tuning
    if (!isNaN(afterClick) && Math.abs(afterClick - clampedValue) < Math.abs(now - clampedValue)) {
        // Click moved us in the right direction, use arrows to fine-tune
        const stepsNeeded = Math.round((clampedValue - afterClick) / (step || 1));
        const key = orientation === "vertical"
            ? (stepsNeeded > 0 ? "ArrowUp" : "ArrowDown")
            : (stepsNeeded > 0 ? "ArrowRight" : "ArrowLeft");

        await locator.focus();
        for (let i = 0; i < Math.abs(stepsNeeded); i++) {
            await page.keyboard.press(key);
        }
        await page.waitForTimeout(100);

        const afterKeys = await locator.evaluate((el: HTMLElement) => {
            return parseFloat(
                el.getAttribute("aria-valuenow") ??
                (el as HTMLInputElement).value ??
                "NaN"
            );
        });

        console.log(JSON.stringify({ slider: target, value: isNaN(afterKeys) ? afterClick : afterKeys, method: "click+keys" }));
        process.exit(0);
    }

    // Click might have worked but element doesn't expose aria-valuenow
    if (isNaN(afterClick)) {
        console.log(JSON.stringify({ slider: target, value: clampedValue, method: "click", verified: false }));
        process.exit(0);
    }
}

// Strategy 3: Pure keyboard — focus + arrow keys from current position
await locator.focus();
await page.waitForTimeout(100);

const stepsFromCurrent = Math.round((clampedValue - now) / (step || 1));
const key = orientation === "vertical"
    ? (stepsFromCurrent > 0 ? "ArrowUp" : "ArrowDown")
    : (stepsFromCurrent > 0 ? "ArrowRight" : "ArrowLeft");

for (let i = 0; i < Math.abs(stepsFromCurrent); i++) {
    await page.keyboard.press(key);
    // Brief pause between presses to let framework react
    if (i % 5 === 4) await page.waitForTimeout(50);
}
await page.waitForTimeout(200);

const afterKeyboard = await locator.evaluate((el: HTMLElement) => {
    return parseFloat(
        el.getAttribute("aria-valuenow") ??
        (el as HTMLInputElement).value ??
        "NaN"
    );
});

console.log(JSON.stringify({
    slider: target,
    value: isNaN(afterKeyboard) ? clampedValue : afterKeyboard,
    method: "keyboard",
    verified: !isNaN(afterKeyboard),
}));
