// Chain multiple actions: goto | click | fill | wait
// Usage: --chain "goto https://site.com | click Login | fill email=test@x.com"
import { discoverElements, printDiscovery } from "@/discover.js";

const chainStr = process.env.SCRIPT_ARGS || "";
if (!chainStr) {
  console.error("Usage: dev-browser.sh --chain 'goto URL | click BUTTON | fill FIELD=VALUE'");
  console.error("Commands: goto <url>, click <text|selector>, fill <name>=<value>, wait <selector|text>");
  process.exit(1);
}

const client = await connect();
const page = await client.page("main");

// Parse commands (split by |, trim each)
const commands = chainStr.split("|").map(c => c.trim()).filter(c => c);

for (let i = 0; i < commands.length; i++) {
  const cmd = commands[i];
  const [action, ...argParts] = cmd.split(/\s+/);
  const arg = argParts.join(" ");

  console.log(`\n[${i + 1}/${commands.length}] ${action} ${arg}`);

  try {
    switch (action.toLowerCase()) {
      case "goto": {
        let url = arg;
        if (process.env.CACHEBUST === "1" && url && url !== "about:blank") {
          const sep = url.includes("?") ? "&" : "?";
          url = `${url}${sep}v=${Date.now()}`;
        }
        await page.goto(url);
        await waitForPageLoad(page);
        console.log("  → Navigated to:", page.url());
        break;
      }

      case "click": {
        // Check existence first, then click - fail fast
        const btn = page.getByRole("button", { name: arg });
        const link = page.getByRole("link", { name: arg });
        const sel = page.locator(arg).first();

        if (await btn.count() > 0) {
          await btn.click();
          console.log("  → Clicked button:", arg);
        } else if (await link.count() > 0) {
          await link.click();
          console.log("  → Clicked link:", arg);
        } else if (await sel.count() > 0) {
          await sel.click();
          console.log("  → Clicked selector:", arg);
        } else {
          throw new Error(`Element not found: ${arg}`);
        }
        await waitForPageLoad(page);
        break;
      }

      case "fill": {
        const eqIdx = arg.indexOf("=");
        if (eqIdx === -1) {
          throw new Error("fill requires field=value format");
        }
        const field = arg.substring(0, eqIdx);
        const value = arg.substring(eqIdx + 1);

        // Try name, id, placeholder, label
        let filled = false;
        for (const sel of [`[name="${field}"]`, `#${field}`, `[placeholder*="${field}" i]`]) {
          try {
            const el = page.locator(sel).first();
            if (await el.count() > 0) {
              await el.fill(value);
              console.log(`  → Filled ${sel}:`, value);
              filled = true;
              break;
            }
          } catch {}
        }
        if (!filled) {
          try {
            await page.getByLabel(field).fill(value);
            console.log(`  → Filled label "${field}":`, value);
            filled = true;
          } catch {}
        }
        if (!filled) {
          throw new Error(`Field not found: ${field}`);
        }
        break;
      }

      case "wait": {
        try {
          await page.locator(arg).first().waitFor({ timeout: 15000 });
          console.log("  → Found selector:", arg);
        } catch {
          await page.getByText(arg).first().waitFor({ timeout: 15000 });
          console.log("  → Found text:", arg);
        }
        break;
      }

      case "screenshot": {
        const path = arg || `/tmp/chain-${Date.now()}.png`;
        await page.screenshot({ path, fullPage: true });
        console.log("  → Screenshot saved:", path);
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}. Use: goto, click, fill, wait, screenshot`);
    }

    // Show discovery after each action
    const elements = await discoverElements(page);
    if (elements.inputs?.length || elements.buttons?.length) {
      const parts: string[] = [];
      if (elements.inputs?.length) parts.push(`inputs: ${elements.inputs.map(i => i.name).join(", ")}`);
      if (elements.buttons?.length) parts.push(`buttons: ${elements.buttons.map(b => `"${b.text}"`).join(", ")}`);
      console.log("  →", parts.join(" | "));
    }

  } catch (err: any) {
    console.error(`  ✗ FAILED: ${err.message}`);
    // Show what's available for debugging
    const elements = await discoverElements(page);
    printDiscovery(elements, "Available elements");
    await client.disconnect();
    process.exit(1);
  }
}

console.log("\n✓ Chain completed successfully");
console.log("Final URL:", page.url());

await client.disconnect();
