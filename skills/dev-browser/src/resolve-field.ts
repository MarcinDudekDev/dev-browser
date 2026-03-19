import type { Page, Locator } from "playwright";

export interface ResolvedField {
  locator: Locator;
  matchedBy: string;
}

const INPUT_ROLES = ["textbox", "searchbox", "spinbutton", "combobox", "checkbox", "radio"] as const;
const UNCHECK_VALUES = new Set(["off", "false", "uncheck", "no", "0", ""]);

export async function resolveField(page: Page, target: string): Promise<ResolvedField | null> {
  // 1. CSS passthrough (raw selector like .class, #id, [attr], input[...])
  if (/^[a-z]+\[|^\[|^#|^\./.test(target)) {
    try {
      const el = page.locator(target).first();
      if (await el.count() > 0) return { locator: el, matchedBy: target };
    } catch {}
  }

  // 2. ARIA-first: find by accessible name across input roles
  for (const role of INPUT_ROLES) {
    try {
      const el = page.getByRole(role, { name: target });
      if (await el.count() > 0) return { locator: el.first(), matchedBy: `aria:${role}` };
    } catch {}
  }

  // 3. Exact name attribute
  try {
    const el = page.locator(`[name="${target}"]`).first();
    if (await el.count() > 0) return { locator: el, matchedBy: `name:${target}` };
  } catch {}

  // 4. Exact ID
  try {
    const el = page.locator(`#${target}`).first();
    if (await el.count() > 0) return { locator: el, matchedBy: `id:${target}` };
  } catch {}

  return null;
}

/**
 * Smart fill: detects input type and calls the right Playwright method.
 * - text/textarea/search/etc → .fill(value)
 * - checkbox → .check() or .uncheck() based on value
 * - radio → .check()
 * - select → .selectOption(value)
 */
export async function smartFill(resolved: ResolvedField, value: string): Promise<string> {
  const type = await resolved.locator.evaluate((el) => {
    const inp = el as HTMLInputElement;
    if (inp.tagName === "SELECT") return "select";
    return (inp.type || inp.tagName || "").toLowerCase();
  }).catch(() => "");

  try {
    if (type === "checkbox") {
      if (UNCHECK_VALUES.has(value.toLowerCase())) {
        await resolved.locator.uncheck({ timeout: 5000 });
        return "unchecked";
      }
      await resolved.locator.check({ timeout: 5000 });
      return "checked";
    }

    if (type === "radio") {
      await resolved.locator.check({ timeout: 5000 });
      return "checked";
    }

    if (type === "select") {
      await resolved.locator.selectOption(value, { timeout: 5000 });
      return "selected";
    }

    await resolved.locator.fill(value, { timeout: 5000 });
    return "filled";
  } catch (e: any) {
    const msg = e.message?.includes("Timeout")
      ? `Field '${resolved.matchedBy}' found but not actionable (hidden, disabled, or covered)`
      : e.message;
    throw new Error(`smartFill(${resolved.matchedBy}): ${msg}`);
  }
}
