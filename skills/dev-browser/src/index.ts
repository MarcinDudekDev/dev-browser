import express, { type Express, type Request, type Response } from "express";
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Socket } from "net";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
} from "./types";

export type { ServeOptions, GetPageResponse, ListPagesResponse, ServerInfoResponse };

export interface DevBrowserServer {
  wsEndpoint: string;
  port: number;
  stop: () => Promise<void>;
}

// Helper to retry fetch with exponential backoff
async function fetchWithRetry(
  url: string,
  maxRetries = 5,
  delayMs = 500
): Promise<globalThis.Response> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
}

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${message}`)), ms)
    ),
  ]);
}

/**
 * Fix Chrome preferences to prevent crash recovery dialog and auto-restore sessions.
 * Must be called BEFORE launching browser.
 */
function fixChromePreferences(userDataDir: string): void {
  const prefsPath = join(userDataDir, "Default", "Preferences");
  const prefsDir = join(userDataDir, "Default");

  // Ensure Default directory exists
  mkdirSync(prefsDir, { recursive: true });

  let prefs: Record<string, unknown> = {};

  // Load existing preferences if they exist
  if (existsSync(prefsPath)) {
    try {
      const content = readFileSync(prefsPath, "utf-8");
      prefs = JSON.parse(content);
      console.log("Loaded existing Chrome preferences");
    } catch (err) {
      console.warn("Could not parse Chrome preferences, creating new:", err);
      prefs = {};
    }
  }

  // Initialize nested objects if they don't exist
  if (!prefs.profile || typeof prefs.profile !== "object") {
    prefs.profile = {};
  }
  if (!prefs.session || typeof prefs.session !== "object") {
    prefs.session = {};
  }

  const profile = prefs.profile as Record<string, unknown>;
  const session = prefs.session as Record<string, unknown>;

  // Check if this was a crash
  const wasCrashed = profile.exit_type === "Crashed";
  if (wasCrashed) {
    console.log("Detected previous crash - fixing preferences for auto-restore");
  }

  // Fix settings to prevent crash dialog and enable auto-restore:
  // 1. exit_type = "Normal" prevents "Chrome didn't shut down correctly" dialog
  profile.exit_type = "Normal";

  // 2. exited_cleanly = true also helps prevent the dialog
  profile.exited_cleanly = true;

  // 3. restore_on_startup = 1 means "Continue where you left off"
  //    (0 = New Tab, 4 = specific URLs, 5 = reopen last open)
  session.restore_on_startup = 1;

  // Write back the fixed preferences
  try {
    writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
    console.log("Chrome preferences fixed: exit_type=Normal, restore_on_startup=1");
  } catch (err) {
    console.error("Failed to write Chrome preferences:", err);
  }
}

// Stealth script to mask automation indicators
const STEALTH_SCRIPT = `
  // Mask webdriver property
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });

  // Mask automation-controlled property
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete document.$cdc_asdjflasutopfhvcZLmcfl_;

  // Fix permissions API (headless detection)
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications' ?
      Promise.resolve({ state: Notification.permission }) :
      originalQuery(parameters)
  );

  // Add plugins (headless has 0)
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });

  // Fix chrome runtime (missing in automation)
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
`;

export async function serve(options: ServeOptions = {}): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const headless = options.headless ?? false;
  const cdpPort = options.cdpPort ?? 9223;
  const profileDir = options.profileDir;
  const browserMode = options.browserMode ?? "dev";
  const userCdpPort = options.userCdpPort ?? 9222; // Default user Chrome CDP port

  console.log(`Browser mode: ${browserMode}`);

  // Validate port numbers
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}. Must be between 1 and 65535`);
  }
  if (browserMode !== "user" && (cdpPort < 1 || cdpPort > 65535)) {
    throw new Error(`Invalid cdpPort: ${cdpPort}. Must be between 1 and 65535`);
  }
  if (browserMode !== "user" && port === cdpPort) {
    throw new Error("port and cdpPort must be different");
  }

  let context: BrowserContext;
  let wsEndpoint: string;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;

  if (browserMode === "user") {
    // USER MODE: Connect to user's existing Chrome browser
    console.log(`Connecting to user's Chrome on CDP port ${userCdpPort}...`);
    console.log("(Make sure Chrome is running with: --remote-debugging-port=9222)");

    try {
      const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${userCdpPort}/json/version`);
      const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
      wsEndpoint = cdpInfo.webSocketDebuggerUrl;

      browser = await chromium.connectOverCDP(wsEndpoint);
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        throw new Error("No browser context found. Is Chrome running?");
      }
      context = contexts[0];
      console.log(`Connected to user's Chrome (${contexts.length} context(s))`);
    } catch (err) {
      console.error("\n=== USER MODE SETUP REQUIRED ===");
      console.error("To use --user mode, start your browser with remote debugging:");
      console.error("");
      console.error("  Chrome:");
      console.error("    open -a 'Google Chrome' --args --remote-debugging-port=9222");
      console.error("");
      console.error("  Brave:");
      console.error("    open -a 'Brave Browser' --args --remote-debugging-port=9222");
      console.error("");
      console.error("  Run setup helper: ./scripts/setup-brave-debug.sh");
      console.error("================================\n");
      throw err;
    }
  } else {
    // DEV or STEALTH MODE: Launch persistent context
    const userDataDir = profileDir
      ? join(profileDir, "browser-data")
      : join(process.cwd(), ".browser-data");

    mkdirSync(userDataDir, { recursive: true });
    console.log(`Using persistent browser profile: ${userDataDir}`);

    fixChromePreferences(userDataDir);

    console.log("Launching browser with persistent context...");

    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      args: [
        `--remote-debugging-port=${cdpPort}`,
        "--restore-last-session",
        "--disable-session-crashed-bubble",
        // Additional stealth args
        ...(browserMode === "stealth" ? [
          "--disable-blink-features=AutomationControlled",
        ] : []),
      ],
    });
    console.log("Browser launched with persistent profile...");

    const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
    const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
    wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  }

  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

  // Helper to inject stealth scripts (for stealth mode)
  async function injectStealthScripts(page: Page): Promise<void> {
    if (browserMode !== "stealth") return;

    try {
      const cdpSession = await context.newCDPSession(page);
      await cdpSession.send("Page.addScriptToEvaluateOnNewDocument", {
        source: STEALTH_SCRIPT,
      });
      // Also inject on current page
      await page.evaluate(STEALTH_SCRIPT);
      await cdpSession.detach();
    } catch (err) {
      console.warn("Failed to inject stealth scripts:", err);
    }
  }

  // Registry entry type for page tracking
  interface PageEntry {
    page: Page;
    targetId: string;
  }

  // Registry: name -> PageEntry
  const registry = new Map<string, PageEntry>();

  // Helper to get CDP targetId for a page
  async function getTargetId(page: Page): Promise<string> {
    const cdpSession = await context.newCDPSession(page);
    try {
      const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
      return targetInfo.targetId;
    } finally {
      await cdpSession.detach();
    }
  }

  // Express server for page management
  const app: Express = express();
  app.use(express.json());

  // GET / - server info
  app.get("/", (_req: Request, res: Response) => {
    const response: ServerInfoResponse = { wsEndpoint };
    res.json(response);
  });

  // GET /health - quick health check (no JSON parsing needed)
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).send("ok");
  });

  // GET /pages - list all pages
  app.get("/pages", (_req: Request, res: Response) => {
    const response: ListPagesResponse = {
      pages: Array.from(registry.keys()),
    };
    // Include target IDs for cleanup cross-referencing
    const targets: Record<string, string> = {};
    for (const [name, entry] of registry.entries()) {
      targets[name] = entry.targetId;
    }
    res.json({ ...response, targets });
  });

  // POST /pages - get or create page
  app.post("/pages", async (req: Request, res: Response) => {
    const body = req.body as GetPageRequest;
    const { name } = body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required and must be a string" });
      return;
    }

    if (name.length === 0) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }

    if (name.length > 256) {
      res.status(400).json({ error: "name must be 256 characters or less" });
      return;
    }

    // Check if page already exists and is still alive
    let entry = registry.get(name);
    if (entry) {
      try {
        // Verify the page is still open — use isClosed() first (no network call),
        // then evaluate only if needed. This avoids false positives during navigation.
        if (entry.page.isClosed()) {
          throw new Error("page closed");
        }
        await entry.page.evaluate(() => true).catch(async () => {
          // Page might be mid-navigation — wait briefly and retry once
          await new Promise(r => setTimeout(r, 500));
          if (entry!.page.isClosed()) throw new Error("page closed");
          await entry!.page.evaluate(() => true);
        });
      } catch {
        // Page is truly dead/closed — remove stale entry and recreate
        console.log(`Page "${name}" was stale, recreating...`);
        registry.delete(name);
        entry = undefined;
      }
    }
    if (!entry) {
      // Create new page in the persistent context (with timeout to prevent hangs)
      const page = await withTimeout(context.newPage(), 30000, "Page creation timed out after 30s");

      // Inject stealth scripts for stealth mode
      await injectStealthScripts(page);

      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(name, entry);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", () => {
        registry.delete(name);
      });
    }

    // Debug: log what we're returning
    try {
      const url = entry.page.url();
      console.log(`POST /pages "${name}" → targetId=${entry.targetId}, url=${url}`);
    } catch { /* ignore */ }

    const response: GetPageResponse = { wsEndpoint, name, targetId: entry.targetId };
    res.json(response);
  });

  // DELETE /pages/:name - close a page
  app.delete("/pages/:name", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (entry) {
      await entry.page.close();
      registry.delete(name);
      res.json({ success: true });
      return;
    }

    res.status(404).json({ error: "page not found" });
  });

  // POST /pages/:name/screenshot - take screenshot using server's Page object
  // This avoids stale CDP reconnection issues
  app.post("/pages/:name/screenshot", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: `Page "${name}" not found` });
      return;
    }

    try {
      const { path: savePath, fullPage } = req.body as { path?: string; fullPage?: boolean };
      const screenshotPath = savePath || `/tmp/screenshot-${Date.now()}.png`;
      await entry.page.screenshot({ path: screenshotPath, fullPage: fullPage !== false });
      const url = entry.page.url();
      const vp = entry.page.viewportSize() ?? await entry.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null);
      const vpStr = vp ? `${vp.width}x${vp.height}` : 'unknown';
      console.log(`Screenshot "${name}" → ${screenshotPath} (url=${url})`);
      res.json({ success: true, path: screenshotPath, url, viewport: vpStr });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // POST /pages/:name/evaluate - evaluate JS using server's Page object
  app.post("/pages/:name/evaluate", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: `Page "${name}" not found` });
      return;
    }

    try {
      const { code } = req.body as { code: string };
      const result = await entry.page.evaluate((js: string) => {
        try {
          const fn = new Function(`return (${js})`);
          const res = fn();
          if (res && typeof res.then === 'function') {
            return res.then((r: unknown) => ({ success: true, result: r }));
          }
          return { success: true, result: res };
        } catch {
          try { const fn = new Function(js); fn(); return { success: true, result: undefined }; }
          catch (e: unknown) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
        }
      }, code);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // GET /pages/:name/url - get current page URL from server's Page object
  app.get("/pages/:name/url", (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: `Page "${name}" not found` });
      return;
    }

    res.json({ url: entry.page.url(), name });
  });

  // ── Fast-path endpoints (skip tsx) ──────────────────────────────

  // Helper: get page entry or 404
  const getPageEntry = (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);
    if (!entry) {
      res.status(404).json({ error: `Page "${name}" not found` });
      return null;
    }
    return { name, entry };
  };

  // POST /pages/:name/goto - navigate to URL
  app.post("/pages/:name/goto", async (req: Request<{ name: string }>, res: Response) => {
    const r = getPageEntry(req, res);
    if (!r) return;
    const { entry } = r;
    try {
      let { url, cachebust } = req.body as { url: string; cachebust?: boolean };
      if (!url) { res.status(400).json({ error: "url is required" }); return; }
      if (cachebust && url !== "about:blank") {
        const sep = url.includes("?") ? "&" : "?";
        url = `${url}${sep}v=${Date.now()}`;
      }
      await entry.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      try { await entry.page.waitForLoadState("networkidle", { timeout: 10000 }); } catch { /* proceed */ }

      const info = await entry.page.evaluate(() => {
        const links = Array.from(document.querySelectorAll("a[href]"))
          .map(a => ({ href: a.getAttribute("href") || "", text: (a.textContent?.trim() || "").substring(0, 50) }))
          .filter(l => l.href && l.href !== "#" && !l.href.startsWith("javascript:") && !l.href.startsWith("mailto:"))
          .slice(0, 15);
        return { links };
      });
      res.json({ url: entry.page.url(), title: await entry.page.title(), ...info });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/click - click element by text or CSS selector
  app.post("/pages/:name/click", async (req: Request<{ name: string }>, res: Response) => {
    const r = getPageEntry(req, res);
    if (!r) return;
    const { entry } = r;
    try {
      const { target } = req.body as { target: string };
      if (!target) { res.status(400).json({ error: "target is required" }); return; }

      let clickedType = "";
      let clicked = false;

      // Try button role
      try { await entry.page.getByRole("button", { name: target }).click({ timeout: 3000 }); clickedType = "button"; clicked = true; } catch {}
      // Try link role
      if (!clicked) { try { await entry.page.getByRole("link", { name: target }).click({ timeout: 3000 }); clickedType = "link"; clicked = true; } catch {} }
      // Try frames
      if (!clicked) {
        for (const frame of entry.page.frames()) {
          if (clicked) break;
          try { await frame.getByRole("button", { name: target }).click({ timeout: 2000 }); clickedType = "button (frame)"; clicked = true; } catch {
            try { await frame.getByRole("link", { name: target }).click({ timeout: 2000 }); clickedType = "link (frame)"; clicked = true; } catch {}
          }
        }
      }
      // CSS selector fallback
      if (!clicked) { await entry.page.locator(target).first().click({ timeout: 5000 }); clickedType = "selector"; }

      try { await entry.page.waitForLoadState("domcontentloaded", { timeout: 5000 }); } catch {}
      const info = await entry.page.evaluate(() => ({
        buttons: [...document.querySelectorAll("button")].slice(0, 5).map(b => b.textContent?.trim()).filter(Boolean),
        links: [...document.querySelectorAll("a")].slice(0, 5).map(a => a.textContent?.trim()).filter(Boolean),
      }));
      res.json({ clicked: target, type: clickedType, url: entry.page.url(), next: info });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/fill - fill form field by name/id/label/selector
  app.post("/pages/:name/fill", async (req: Request<{ name: string }>, res: Response) => {
    const r = getPageEntry(req, res);
    if (!r) return;
    const { entry } = r;
    try {
      const { target, value } = req.body as { target: string; value: string };
      if (!target || value === undefined) { res.status(400).json({ error: "target and value are required" }); return; }

      const looksLikeSelector = /^[a-z]+\[|^\[|^#|^\./.test(target);
      let filled = false;
      let filledWith = "";

      if (looksLikeSelector) {
        try { const el = entry.page.locator(target).first(); if (await el.count() > 0) { await el.fill(value); filledWith = target; filled = true; } } catch {}
      }
      if (!filled) {
        for (const sel of [`[name="${target}"]`, `#${target}`, `[placeholder*="${target}" i]`]) {
          try { const el = entry.page.locator(sel).first(); if (await el.count() > 0) { await el.fill(value); filledWith = sel; filled = true; break; } } catch {}
        }
      }
      if (!filled) { try { await entry.page.getByLabel(target).fill(value); filledWith = `label:${target}`; filled = true; } catch {} }
      if (!filled) { res.status(404).json({ error: `Field '${target}' not found` }); return; }

      res.json({ filled: target, value, selector: filledWith });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/select - select option by value
  app.post("/pages/:name/select", async (req: Request<{ name: string }>, res: Response) => {
    const r = getPageEntry(req, res);
    if (!r) return;
    const { entry } = r;
    try {
      const { target, value } = req.body as { target: string; value: string };
      if (!target || !value) { res.status(400).json({ error: "target and value are required" }); return; }
      const sel = /^[.#\[]/.test(target) ? target : `[name="${target}"], #${target}`;
      await entry.page.locator(sel).first().selectOption(value);
      res.json({ selected: target, value });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/text - get text content of element
  app.post("/pages/:name/text", async (req: Request<{ name: string }>, res: Response) => {
    const r = getPageEntry(req, res);
    if (!r) return;
    const { entry } = r;
    try {
      const { target } = req.body as { target: string };
      if (!target) { res.status(400).json({ error: "target is required" }); return; }
      const el = entry.page.locator(target).first();
      if (await el.count() === 0) { res.status(404).json({ error: `Selector '${target}' not found` }); return; }
      const text = await el.textContent();
      res.json({ text: text?.trim() || "" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Start the server
  const server = app.listen(port, () => {
    console.log(`HTTP API server running on port ${port}`);
  });

  // Track active connections for clean shutdown
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  // Track if cleanup has been called to avoid double cleanup
  let cleaningUp = false;

  // Cleanup function
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;

    console.log("\nShutting down...");

    // Close all active HTTP connections
    for (const socket of connections) {
      socket.destroy();
    }
    connections.clear();

    // Close all pages
    for (const entry of registry.values()) {
      try {
        await entry.page.close();
      } catch {
        // Page might already be closed
      }
    }
    registry.clear();

    // Close context (this also closes the browser) - but NOT in user mode
    if (browserMode !== "user") {
      try {
        await context.close();
      } catch {
        // Context might already be closed
      }
    } else {
      // In user mode, just disconnect from browser (don't close it)
      if (browser) {
        try {
          await browser.close();
        } catch {
          // Browser connection might already be closed
        }
      }
    }

    server.close();
    console.log("Server stopped.");
  };

  // Synchronous cleanup for forced exits
  const syncCleanup = () => {
    try {
      context.close();
    } catch {
      // Best effort
    }
  };

  // Signal handlers (consolidated to reduce duplication)
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  const signalHandler = async () => {
    await cleanup();
    process.exit(0);
  };

  // Error handler - log but DON'T exit for recoverable errors
  const errorHandler = (err: unknown, type: string) => {
    const timestamp = new Date().toISOString();
    const errMsg = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`[${timestamp}] ${type}: ${errMsg}`);

    // Only exit on truly fatal errors
    const errStr = String(err).toLowerCase();
    const fatalPatterns = [
      "cannot find module",
      "eaddrinuse",
      "out of memory",
      "heap out of memory",
    ];

    const isFatal = fatalPatterns.some((p) => errStr.includes(p));
    if (isFatal) {
      console.error(`[${timestamp}] FATAL ERROR - server will exit`);
      cleanup().finally(() => process.exit(1));
    } else {
      console.error(`[${timestamp}] Recoverable error - server continues`);
    }
  };

  // Register handlers
  signals.forEach((sig) => process.on(sig, signalHandler));
  process.on("uncaughtException", (err) => errorHandler(err, "uncaughtException"));
  process.on("unhandledRejection", (err) => errorHandler(err, "unhandledRejection"));
  process.on("exit", syncCleanup);

  // Wrapped error handlers for removal
  const uncaughtHandler = (err: unknown) => errorHandler(err, "uncaughtException");
  const rejectionHandler = (err: unknown) => errorHandler(err, "unhandledRejection");

  // Re-register with the wrappers for proper removal
  process.off("uncaughtException", uncaughtHandler);
  process.off("unhandledRejection", rejectionHandler);
  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", rejectionHandler);

  // Helper to remove all handlers
  const removeHandlers = () => {
    signals.forEach((sig) => process.off(sig, signalHandler));
    process.off("uncaughtException", uncaughtHandler);
    process.off("unhandledRejection", rejectionHandler);
    process.off("exit", syncCleanup);
  };

  return {
    wsEndpoint,
    port,
    async stop() {
      removeHandlers();
      await cleanup();
    },
  };
}
