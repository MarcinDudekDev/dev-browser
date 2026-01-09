// Shared discovery helper - outputs key page elements after actions
// Usage: import { discoverElements } from "./_discover.js";

import type { Page } from "playwright";

export interface PageElements {
  url: string;
  title: string;
  inputs?: Array<{ name: string | null; type: string | null; id: string | null }>;
  buttons?: Array<{ text: string | null; id: string | null }>;
  links?: Array<{ text: string | null; href: string }>;
}

// Lightweight discovery - just key interactive elements
export async function discoverElements(page: Page): Promise<PageElements> {
  const info = await page.evaluate(() => {
    // All inputs (including those in forms)
    const inputs = Array.from(document.querySelectorAll('input, select, textarea'))
      .slice(0, 10)
      .map(el => ({
        name: el.getAttribute('name') || el.id || null,
        type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
        id: el.id || null
      }))
      .filter(f => f.type !== 'hidden' && f.name);

    // Buttons
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
      .slice(0, 6)
      .map(el => ({
        text: el.textContent?.trim().substring(0, 30) || (el as HTMLInputElement).value || null,
        id: el.id || null
      }))
      .filter(b => b.text);

    // Key links (skip anchors, javascript, etc.)
    const seen = new Set<string>();
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ href: a.getAttribute('href') || '', text: a.textContent?.trim().substring(0, 30) || '' }))
      .filter(l => {
        if (!l.href || l.href === '#' || l.href.startsWith('javascript:')) return false;
        if (seen.has(l.href)) return false;
        seen.add(l.href);
        return l.text.length > 0;
      })
      .slice(0, 6);

    return { inputs, buttons, links };
  });

  return {
    url: page.url(),
    title: await page.title(),
    inputs: info.inputs.length > 0 ? info.inputs : undefined,
    buttons: info.buttons.length > 0 ? info.buttons : undefined,
    links: info.links.length > 0 ? info.links : undefined
  };
}

// Print discovery results in a compact, readable format
export function printDiscovery(elements: PageElements, label: string = "Page state"): void {
  console.log(`\n=== ${label} ===`);
  console.log(`URL: ${elements.url}`);

  if (elements.inputs?.length) {
    console.log(`Inputs: ${elements.inputs.map(i => i.name || i.id).join(', ')}`);
  }
  if (elements.buttons?.length) {
    console.log(`Buttons: ${elements.buttons.map(b => `"${b.text}"`).join(', ')}`);
  }
  if (elements.links?.length) {
    console.log(`Links: ${elements.links.map(l => l.text).join(', ')}`);
  }
}
