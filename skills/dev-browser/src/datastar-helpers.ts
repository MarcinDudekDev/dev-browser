/**
 * Datastar-specific helpers for dev-browser
 *
 * Datastar uses reactive signals bound to inputs via data-bind.
 * Playwright's fill() sets values but may not trigger Datastar's signal updates.
 * These helpers provide workarounds.
 */

import type { Page, Locator } from "playwright";

/**
 * Fill a Datastar-bound input field and wait for SSE response.
 *
 * This uses keyboard.type() which more reliably triggers Datastar's event handlers
 * compared to fill(). It also waits for the SSE-driven DOM update.
 *
 * @param page - Playwright page
 * @param selector - CSS selector for the input
 * @param value - Value to type
 * @param options - Configuration options
 */
export interface DatastarFillOptions {
  /** Debounce time to wait before expecting SSE request (default: 300) */
  debounceMs?: number;
  /** Timeout for waiting for DOM update (default: 5000) */
  timeout?: number;
  /** Selector to watch for content change (if different from dropdown) */
  watchSelector?: string;
  /** Typing delay between characters (default: 50) */
  typeDelay?: number;
  /** Clear existing value first (default: true) */
  clear?: boolean;
}

export async function datastarFill(
  page: Page,
  selector: string,
  value: string,
  options: DatastarFillOptions = {}
): Promise<{ success: boolean; reason?: string }> {
  const {
    debounceMs = 300,
    timeout = 5000,
    watchSelector,
    typeDelay = 50,
    clear = true,
  } = options;

  const input = page.locator(selector);

  // Focus and optionally clear
  await input.click();
  if (clear) {
    await input.clear();
  }

  // Get initial state of the watch target for comparison
  const initialContent = watchSelector
    ? await page.locator(watchSelector).innerHTML().catch(() => "")
    : "";

  // Type the value character by character (more reliable for Datastar)
  await page.keyboard.type(value, { delay: typeDelay });

  // Wait for debounce + network + rendering
  await page.waitForTimeout(debounceMs + 100);

  // If we have a watch selector, wait for its content to change
  if (watchSelector) {
    try {
      await page.waitForFunction(
        ({ sel, initial }) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          return el.innerHTML !== initial && el.innerHTML.trim().length > 0;
        },
        { sel: watchSelector, initial: initialContent },
        { timeout }
      );
      return { success: true };
    } catch {
      return {
        success: false,
        reason: `Timeout waiting for ${watchSelector} to update`,
      };
    }
  }

  // No watch selector - just wait for network idle
  try {
    await page.waitForLoadState("networkidle", { timeout });
    return { success: true };
  } catch {
    return { success: true, reason: "Completed without waiting for network" };
  }
}

/**
 * Fill input and manually trigger Datastar signal update.
 *
 * Use this when keyboard.type() doesn't work. It directly sets the value
 * and dispatches events that Datastar should handle.
 *
 * @param page - Playwright page
 * @param selector - CSS selector for the input
 * @param value - Value to set
 */
export async function datastarFillDirect(
  page: Page,
  selector: string,
  value: string
): Promise<void> {
  await page.evaluate(
    ({ sel, val }) => {
      const input = document.querySelector(sel) as HTMLInputElement;
      if (!input) throw new Error("Input not found: " + sel);

      // Focus first
      input.focus();

      // Set value
      input.value = val;

      // Dispatch events that Datastar listens to
      // Standard input event
      input.dispatchEvent(
        new Event("input", { bubbles: true, cancelable: true })
      );

      // InputEvent with more details (for data-bind)
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: val,
        })
      );

      // Some Datastar setups also use change
      input.dispatchEvent(
        new Event("change", { bubbles: true, cancelable: true })
      );

      // Try to trigger data-on:input handler if present
      const onInput = input.getAttribute("data-on:input");
      if (onInput && onInput.includes("@get") || onInput?.includes("@post")) {
        // The handler should fire from the events above
        // If not, we might need to manually trigger Datastar
      }
    },
    { sel: selector, val: value }
  );
}

/**
 * Wait for Datastar SSE response to update a specific element.
 *
 * @param page - Playwright page
 * @param selector - Element to watch for changes
 * @param options - Wait options
 */
export interface WaitForDatastarUpdateOptions {
  /** Max time to wait (default: 5000) */
  timeout?: number;
  /** Expected content to contain */
  contains?: string;
  /** Expect content to be non-empty (default: true) */
  nonEmpty?: boolean;
}

export async function waitForDatastarUpdate(
  page: Page,
  selector: string,
  options: WaitForDatastarUpdateOptions = {}
): Promise<boolean> {
  const { timeout = 5000, contains, nonEmpty = true } = options;

  try {
    await page.waitForFunction(
      ({ sel, contains: c, nonEmpty: ne }) => {
        const el = document.querySelector(sel);
        if (!el) return false;

        const content = el.innerHTML;

        if (ne && content.trim().length === 0) return false;
        if (c && !content.includes(c)) return false;

        return true;
      },
      { sel: selector, contains, nonEmpty },
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Datastar is loaded and properly initialized on the page.
 *
 * @param page - Playwright page
 */
export async function isDatastarReady(page: Page): Promise<{
  loaded: boolean;
  signalElements: number;
  actionElements: number;
}> {
  return page.evaluate(() => {
    // Check for Datastar elements
    const signalElements = document.querySelectorAll("[data-signals]").length;
    const bindElements = document.querySelectorAll("[data-bind]").length;
    const actionElements = document.querySelectorAll(
      "[data-on\\:click], [data-on\\:input], [data-on\\:submit]"
    ).length;

    // Check for Datastar global (varies by version)
    // @ts-ignore
    const hasGlobal =
      // @ts-ignore
      typeof Datastar !== "undefined" ||
      // @ts-ignore
      typeof window.Datastar !== "undefined";

    return {
      loaded: hasGlobal || signalElements > 0 || actionElements > 0,
      signalElements: signalElements + bindElements,
      actionElements,
    };
  });
}

/**
 * Debug helper: Get all Datastar attributes on a page for inspection.
 *
 * @param page - Playwright page
 */
export async function getDatastarDebugInfo(page: Page): Promise<{
  elements: Array<{
    selector: string;
    attributes: Record<string, string>;
  }>;
  fetchCallsMade: number;
}> {
  return page.evaluate(() => {
    const elements: Array<{
      selector: string;
      attributes: Record<string, string>;
    }> = [];

    // Find all elements with data-* attributes
    const allElements = document.querySelectorAll("*");
    allElements.forEach((el, index) => {
      const attrs: Record<string, string> = {};
      let hasDatastarAttr = false;

      Array.from(el.attributes).forEach((attr) => {
        if (
          attr.name.startsWith("data-") &&
          (attr.name.includes("signal") ||
            attr.name.includes("bind") ||
            attr.name.includes("on:") ||
            attr.name.includes("text") ||
            attr.name.includes("show") ||
            attr.name.includes("class"))
        ) {
          attrs[attr.name] = attr.value;
          hasDatastarAttr = true;
        }
      });

      if (hasDatastarAttr) {
        // Build a useful selector
        const id = el.id ? "#" + el.id : "";
        const classes = el.className
          ? "." + String(el.className).split(" ").filter(Boolean).join(".")
          : "";
        const tag = el.tagName.toLowerCase();

        elements.push({
          selector: id || (classes ? tag + classes : tag + "[" + index + "]"),
          attributes: attrs,
        });
      }
    });

    return {
      elements,
      fetchCallsMade: 0, // Would need to hook fetch to track this
    };
  });
}
