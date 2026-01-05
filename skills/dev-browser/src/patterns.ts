import type { Page } from "playwright";
import {
  waitForPageLoad,
  waitForElement,
  waitForElementGone,
  waitForURL,
  type FillFormOptions,
  type FillFormResult,
} from "./client";

/**
 * Login pattern options
 */
export interface LoginOptions {
  /** Login page URL */
  url: string;
  /** Username/email */
  user: string;
  /** Password */
  pass: string;
  /** Custom selectors (defaults to WordPress) */
  selectors?: {
    username?: string;
    password?: string;
    submit?: string;
  };
  /** Element/URL to wait for after login */
  waitFor?: string | RegExp;
  /** Timeout in ms (default: 10000) */
  timeout?: number;
}

/**
 * Generic login flow for WordPress and similar forms.
 * Handles navigation, form filling, submission, and verification.
 *
 * @example
 * // WordPress with defaults
 * await login(page, {
 *   url: 'https://site.com/wp-login.php',
 *   user: 'admin',
 *   pass: 'password123'
 * });
 *
 * @example
 * // Custom selectors
 * await login(page, {
 *   url: 'https://app.com/login',
 *   user: 'user@example.com',
 *   pass: 'secret',
 *   selectors: {
 *     username: '#email',
 *     password: '#pass',
 *     submit: 'button[type="submit"]'
 *   },
 *   waitFor: '/dashboard'
 * });
 */
export async function login(page: Page, options: LoginOptions): Promise<boolean> {
  const {
    url,
    user,
    pass,
    selectors = {},
    waitFor,
    timeout = 10000,
  } = options;

  // Default to WordPress selectors
  const usernameSelector = selectors.username || "#user_login";
  const passwordSelector = selectors.password || "#user_pass";
  const submitSelector = selectors.submit || "#wp-submit";

  try {
    // Navigate to login if not already there
    if (!page.url().includes(new URL(url).pathname)) {
      await page.goto(url);
      await waitForPageLoad(page, { timeout });
    }

    // Fill credentials
    await page.fill(usernameSelector, user);
    await page.fill(passwordSelector, pass);

    // Submit
    await page.click(submitSelector);
    await waitForPageLoad(page, { timeout });

    // Wait for success indicator if specified
    if (waitFor) {
      if (typeof waitFor === "string") {
        // Check if it's a URL pattern or selector
        if (waitFor.startsWith("/") || waitFor.includes("://")) {
          await waitForURL(page, waitFor, { timeout });
        } else {
          await waitForElement(page, waitFor, { timeout });
        }
      } else {
        await waitForURL(page, waitFor, { timeout });
      }
    } else {
      // Default: wait a bit for redirect
      await page.waitForTimeout(2000);
    }

    return true;
  } catch (err) {
    console.error("Login failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Fill and submit form pattern options
 */
export interface FillAndSubmitOptions extends Omit<FillFormOptions, "submit"> {
  /** Form fields to fill */
  fields: Record<string, string>;
  /** Submit button selector */
  submit: string;
  /** Element/URL to wait for after submit */
  waitFor?: string | RegExp;
  /** Timeout in ms (default: 10000) */
  timeout?: number;
}

/**
 * Fill form fields and submit.
 * Combines fillForm helper with submit action and verification.
 *
 * @example
 * await fillAndSubmit(page, {
 *   fields: {
 *     'email': 'user@example.com',
 *     'name': 'John Doe',
 *     'message': 'Hello world'
 *   },
 *   submit: 'button[type="submit"]',
 *   waitFor: '.success-message'
 * });
 */
export async function fillAndSubmit(
  page: Page,
  options: FillAndSubmitOptions
): Promise<FillFormResult & { submitted: boolean }> {
  const { fields, submit, waitFor, timeout = 10000, clear = true } = options;

  try {
    // Fill fields using page.fill directly for simplicity
    const filled: string[] = [];
    const notFound: string[] = [];

    for (const [label, value] of Object.entries(fields)) {
      const selectors = [
        `[name="${label}"]`,
        `#${label}`,
        `[placeholder*="${label}" i]`,
        `[aria-label*="${label}" i]`,
      ];

      let found = false;
      for (const selector of selectors) {
        try {
          const element = page.locator(selector).first();
          if ((await element.count()) > 0) {
            if (clear) {
              await element.click({ clickCount: 3 });
              await page.keyboard.press("Backspace");
            }
            await element.fill(value);
            filled.push(label);
            found = true;
            break;
          }
        } catch {
          // Try next selector
        }
      }

      if (!found) {
        // Try by label text
        try {
          await page.getByLabel(label).fill(value);
          filled.push(label);
        } catch {
          notFound.push(label);
        }
      }
    }

    // Submit form
    let submitted = false;
    if (filled.length > 0) {
      await page.click(submit);
      submitted = true;
      await waitForPageLoad(page, { timeout });

      // Wait for success indicator if specified
      if (waitFor) {
        if (typeof waitFor === "string") {
          if (waitFor.startsWith("/") || waitFor.includes("://")) {
            await waitForURL(page, waitFor, { timeout });
          } else {
            await waitForElement(page, waitFor, { timeout });
          }
        } else {
          await waitForURL(page, waitFor, { timeout });
        }
      }
    }

    return { filled, notFound, submitted };
  } catch (err) {
    console.error("fillAndSubmit failed:", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Modal interaction pattern options
 */
export interface ModalOptions {
  /** Trigger to open modal (selector to click) */
  open: string;
  /** Modal container selector for verification */
  modal?: string;
  /** Action to perform inside modal (selector to click) */
  action?: string;
  /** Close button selector (if action doesn't close) */
  close?: string;
  /** Take screenshot before closing */
  screenshot?: string;
  /** Timeout in ms (default: 5000) */
  timeout?: number;
}

/**
 * Handle modal interaction flow.
 * Opens modal, optionally performs action, optionally screenshots, closes.
 *
 * @example
 * // Simple modal with action
 * await modal(page, {
 *   open: '.open-settings',
 *   modal: '.settings-modal',
 *   action: '.save-button'
 * });
 *
 * @example
 * // Modal with screenshot
 * await modal(page, {
 *   open: '.show-preview',
 *   modal: '.preview-modal',
 *   screenshot: '/tmp/preview.png',
 *   close: '.modal-close'
 * });
 */
export async function modal(page: Page, options: ModalOptions): Promise<boolean> {
  const {
    open,
    modal: modalSelector,
    action,
    close,
    screenshot,
    timeout = 5000,
  } = options;

  try {
    // Open modal
    await page.click(open);

    // Wait for modal to appear
    if (modalSelector) {
      await waitForElement(page, modalSelector, { timeout });
    } else {
      // Small delay for modal animation
      await page.waitForTimeout(500);
    }

    // Perform action if specified
    if (action) {
      await page.click(action);
      // Wait for action to complete
      await page.waitForTimeout(500);
    }

    // Take screenshot if requested
    if (screenshot) {
      await page.screenshot({ path: screenshot });
    }

    // Close modal if close button specified
    if (close) {
      await page.click(close);

      // Wait for modal to disappear
      if (modalSelector) {
        await waitForElementGone(page, modalSelector, { timeout });
      }
    }

    return true;
  } catch (err) {
    console.error("Modal interaction failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Responsive testing pattern options
 */
export interface ResponsiveOptions {
  /** URL to test (optional if already on page) */
  url?: string;
  /** Viewports to test (defaults to common breakpoints) */
  viewports?: Array<{ width: number; height: number; name: string }>;
  /** Screenshot base path (will append viewport name) */
  screenshots?: string;
  /** Timeout in ms (default: 10000) */
  timeout?: number;
}

/**
 * Test page across multiple viewports.
 * Useful for responsive design verification.
 *
 * @example
 * // Test with default viewports
 * await responsive(page, {
 *   url: 'https://site.com',
 *   screenshots: '/tmp/responsive'
 * });
 *
 * @example
 * // Custom viewports
 * await responsive(page, {
 *   viewports: [
 *     { width: 320, height: 568, name: 'mobile-small' },
 *     { width: 768, height: 1024, name: 'tablet' },
 *     { width: 1920, height: 1080, name: 'desktop' }
 *   ],
 *   screenshots: '/tmp/test'
 * });
 */
export async function responsive(page: Page, options: ResponsiveOptions): Promise<boolean> {
  const {
    url,
    viewports = [
      { width: 375, height: 812, name: "mobile" },
      { width: 768, height: 1024, name: "tablet" },
      { width: 1280, height: 900, name: "desktop" },
      { width: 1920, height: 1080, name: "desktop-large" },
    ],
    screenshots,
    timeout = 10000,
  } = options;

  try {
    // Navigate if URL provided
    if (url) {
      await page.goto(url);
      await waitForPageLoad(page, { timeout });
    }

    // Test each viewport
    for (const viewport of viewports) {
      console.log(`Testing ${viewport.name} (${viewport.width}x${viewport.height})`);

      // Set viewport
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });

      // Reload to ensure responsive styles apply
      await page.reload();
      await waitForPageLoad(page, { timeout });

      // Small delay for layout
      await page.waitForTimeout(500);

      // Screenshot if requested
      if (screenshots) {
        const path = `${screenshots}-${viewport.name}.png`;
        await page.screenshot({ path, fullPage: true });
        console.log(`Screenshot saved: ${path}`);
      }
    }

    // Reset to desktop
    await page.setViewportSize({ width: 1280, height: 900 });

    return true;
  } catch (err) {
    console.error("Responsive test failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
