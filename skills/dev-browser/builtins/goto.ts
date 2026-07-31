// Navigate to URL and inspect page structure
const client = await connect();
const page = await client.page("main");
let url = process.env.SCRIPT_ARGS || process.argv[2] || "about:blank";

// Cache busting - append timestamp to bypass cache
if (process.env.CACHEBUST === '1' && url && url !== 'about:blank') {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}v=${Date.now()}`;
}

// Navigate with 30s timeout, wait for domcontentloaded (faster than 'load')
// This prevents zombie processes from hanging on slow pages
await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
});

// Additional wait for network idle (10s timeout, won't hang)
try {
    await waitForPageLoad(page, { timeout: 10000, waitForNetworkIdle: true });
} catch {
    // Page loaded but network still active - proceed anyway
}

// Compact page state output
const state = await page.evaluate(() => {
  const doc = document;
  const lines: string[] = [];

  // Forms summary - compact format
  const forms = doc.querySelectorAll("form");
  forms.forEach((form) => {
    const id = form.id || form.getAttribute("name") || "(unnamed)";
    const fields: string[] = [];
    form.querySelectorAll("input, select, textarea").forEach((el) => {
      const inp = el as HTMLInputElement;
      const name = inp.name || inp.id || inp.placeholder || inp.type;
      if (name && inp.type !== "hidden") {
        fields.push(`${name}[${inp.type || el.tagName.toLowerCase()}]`);
      }
    });
    if (fields.length > 0) {
      lines.push(`Form #${id}: ${fields.join(", ")}`);
    }
  });

  // Standalone inputs (not in forms)
  const standaloneInputs: string[] = [];
  doc.querySelectorAll("input:not(form input), select:not(form select), textarea:not(form textarea)").forEach((el) => {
    const inp = el as HTMLInputElement;
    const name = inp.name || inp.id || inp.placeholder || inp.type;
    if (name && inp.type !== "hidden") {
      standaloneInputs.push(`${name}[${inp.type || el.tagName.toLowerCase()}]`);
    }
  });
  if (standaloneInputs.length > 0) {
    lines.push(`Inputs: ${standaloneInputs.slice(0, 10).join(", ")}`);
  }

  // Visible buttons
  const buttons: string[] = [];
  doc.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((el) => {
    const text = (el.textContent || (el as HTMLInputElement).value || "").trim().substring(0, 30);
    if (text && !buttons.includes(text)) buttons.push(text);
  });
  if (buttons.length > 0) {
    lines.push(`Buttons: ${buttons.slice(0, 8).join(", ")}`);
  }

  // Iframes
  const iframes = doc.querySelectorAll("iframe");
  if (iframes.length > 0) {
    const iframeInfo = Array.from(iframes).slice(0, 5).map(f => {
      const name = f.name || f.id || "";
      const src = f.src?.substring(0, 60) || "";
      return name ? `${name}(${src})` : src;
    }).filter(Boolean);
    if (iframeInfo.length > 0) lines.push(`Iframes: ${iframeInfo.join(", ")}`);
  }

  // Key links (nav, main content, or first 15 unique)
  const links: string[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll("a[href]").forEach((el) => {
    const text = (el.textContent || "").trim().substring(0, 30);
    const href = el.getAttribute("href") || "";
    if (text && !seen.has(text) && href !== "#" && !href.startsWith("javascript:") && !href.startsWith("mailto:")) {
      seen.add(text);
      links.push(text);
    }
  });
  if (links.length > 0) {
    lines.push(`Links: ${links.slice(0, 15).join(", ")}`);
  }

  return lines.join("\n");
});

console.log(`URL: ${page.url()}`);
console.log(`Title: ${await page.title()}`);
if (state) console.log(state);

await client.disconnect();
