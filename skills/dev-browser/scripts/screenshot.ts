// Take full-page screenshot using server's Page object (avoids stale CDP)
// Usage: dev-browser.sh --screenshot [page] [filename]
import * as path from "path";
import { mkdirSync } from "fs";

const args = process.env.SCRIPT_ARGS || "";
const pageName = process.env.PAGE_NAME || "main";
const prefix = process.env.PROJECT_PREFIX || "dev";
const serverPort = process.env.SERVER_PORT || "9222";

// Determine screenshot path
const screenshotsDir = process.env.SCREENSHOTS_DIR || path.join(process.env.HOME || "/tmp", "Tools/screenshots");
const filename = args.trim() || `screenshot-${Date.now()}.png`;
const screenshotPath = path.join(screenshotsDir, path.basename(filename));

mkdirSync(screenshotsDir, { recursive: true });

// Use server-side screenshot (server's Page object is always current)
const fullName = `${prefix}-${pageName}`;
const serverUrl = `http://localhost:${serverPort}`;

// Check which page name exists
const listRes = await fetch(`${serverUrl}/pages`);
const { pages } = await listRes.json() as { pages: string[] };
let targetName = fullName;
if (!pages.includes(fullName) && pages.includes(pageName)) {
    targetName = pageName;
}

const res = await fetch(`${serverUrl}/pages/${encodeURIComponent(targetName)}/screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: screenshotPath, fullPage: true }),
});

const result = await res.json() as { success?: boolean; path?: string; url?: string; viewport?: string; error?: string };

if (result.success) {
    // Get viewport via evaluate endpoint
    let vpStr = result.viewport || 'unknown';
    if (vpStr === 'unknown') {
        try {
            const vpRes = await fetch(`${serverUrl}/pages/${encodeURIComponent(targetName)}/evaluate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: "({width: window.innerWidth, height: window.innerHeight})" }),
            });
            const vpData = await vpRes.json() as { success?: boolean; result?: { width: number; height: number } };
            if (vpData.success && vpData.result) vpStr = `${vpData.result.width}x${vpData.result.height}`;
        } catch {}
    }
    console.log(`Page URL: ${result.url} | Alias: ${targetName} | Viewport: ${vpStr}`);
    console.log(`Screenshot saved: ${result.path}`);
} else {
    console.error(`Screenshot failed: ${result.error}`);
    process.exit(1);
}
