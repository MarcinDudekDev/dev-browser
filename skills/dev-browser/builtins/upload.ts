// Upload file to a file input element
// Usage: dev-browser.sh upload '<selector|ref>' '/path/to/file.png'
// Also searches iframes (for Tally forms, etc.)
const args = process.env.SCRIPT_ARGS || "";
if (!args) {
    console.error("Usage: upload <selector|ref> <filepath>");
    console.error("Examples:");
    console.error("  upload e5 /tmp/logo.png");
    console.error("  upload 'input[type=file]' /tmp/photo.jpg");
    console.error("  upload file /tmp/doc.pdf  (by name attribute)");
    process.exit(1);
}

// Parse: first token = selector/ref, rest = file path
const spaceIdx = args.indexOf(" ");
if (spaceIdx === -1) {
    console.error("Usage: upload <selector|ref> <filepath>");
    process.exit(1);
}
const target = args.slice(0, spaceIdx);
const filePath = args.slice(spaceIdx + 1).trim();

import * as fs from "fs";
if (!fs.existsSync(filePath)) {
    console.error(JSON.stringify({ error: `File not found: ${filePath}` }));
    process.exit(1);
}

const isRef = /^e\d+$/.test(target);

if (isRef) {
    // Upload by ARIA snapshot ref
    try {
        const pageName = process.env.PAGE_NAME || "main";
        const prefix = process.env.PROJECT_PREFIX || "dev";
        const element = await client.selectSnapshotRef(`${prefix}-${pageName}`, target);
        await element.setInputFiles(filePath);
        console.log(JSON.stringify({ uploaded: filePath, target, type: "ref" }));
    } catch (e: any) {
        console.error(JSON.stringify({ error: `Ref '${target}' not found or not a file input.` }));
        process.exit(1);
    }
} else {
    // Build selector
    const looksLikeSelector = /^[a-z]+\[|^\[|^#|^\./.test(target);
    let uploaded = false;

    const tryUpload = async (locator: any, label: string): Promise<boolean> => {
        try {
            if (await locator.count() > 0) {
                await locator.setInputFiles(filePath);
                console.log(JSON.stringify({ uploaded: filePath, target, selector: label }));
                return true;
            }
        } catch {}
        return false;
    };

    // Try main page first
    if (looksLikeSelector) {
        uploaded = await tryUpload(page.locator(target).first(), target);
    }

    if (!uploaded) {
        const selectors = [
            `input[type="file"][name="${target}"]`,
            `input[type="file"]#${target}`,
            `input[type="file"]`,  // fallback: first file input if target is generic
        ];
        // Only use generic fallback if target is "file" or "upload"
        const sels = /^(file|upload)$/i.test(target) ? selectors : selectors.slice(0, 2);
        for (const sel of sels) {
            uploaded = await tryUpload(page.locator(sel).first(), sel);
            if (uploaded) break;
        }
    }

    // Search iframes (Tally, embedded forms)
    if (!uploaded) {
        const frames = page.frames();
        for (const frame of frames) {
            if (frame === page.mainFrame()) continue;
            try {
                const sel = looksLikeSelector ? target : `input[type="file"][name="${target}"]`;
                const el = frame.locator(sel).first();
                if (await el.count() > 0) {
                    await el.setInputFiles(filePath);
                    console.log(JSON.stringify({ uploaded: filePath, target, selector: sel, iframe: true }));
                    uploaded = true;
                    break;
                }
                // Also try generic file input in iframe
                const generic = frame.locator('input[type="file"]').first();
                if (await generic.count() > 0) {
                    await generic.setInputFiles(filePath);
                    console.log(JSON.stringify({ uploaded: filePath, target: "input[type=file]", iframe: true }));
                    uploaded = true;
                    break;
                }
            } catch {}
        }
    }

    if (!uploaded) {
        console.error(JSON.stringify({ error: `File input '${target}' not found (checked page and iframes)` }));
        process.exit(1);
    }
}
