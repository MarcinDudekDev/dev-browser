import express, { type Express, type Request, type Response } from "express";
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { execFile } from "child_process";
import { join } from "path";
import type { Socket } from "net";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
} from "./types";
import { humanMouseMove, getElementCenter, startIdleMovement, stopIdleMovement } from "./mouse-human";
import { resolveField, smartFill } from "./resolve-field.js";
import { getSnapshotScript } from "./snapshot/browser-script";
import { CDPConnection, makeUserContext } from "./cdp-page.js";

export type { ServeOptions, GetPageResponse, ListPagesResponse, ServerInfoResponse };

export interface DevBrowserServer {
  wsEndpoint: string;
  port: number;
  stop: () => Promise<void>;
}

// ── Module-scope constants ──────────────────────────────────────
const HTTP = {
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  TIMEOUT: 408,
  GONE: 410,
  TOO_MANY_REQUESTS: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

const TIMEOUTS = {
  STALE_PROCESS_KILL: 1000,
  SETTLE: 2000,
  NAVIGATION: 3000,
  SHORT: 5000,
  MEDIUM: 10000,
  LONG: 30000,
} as const;

const LIMITS = {
  SMALL_STEP: 5,
  CLICK_PADDING: 8,
  MEDIUM_STEP: 10,
  MOVE_STEP: 15,
  LARGE_STEP: 20,
  CAPTCHA_OFFSET: 28,
  SCROLL_STEP: 30,
  MOUSE_IDLE: 50,
  MOUSE_RANGE: 60,
  MOUSE_JITTER: 100,
  MAX_PAGE_NAME: 256,
  // Open tabs cost ~85 MB of browser RSS EACH (measured: 0 tabs = 101 MB,
  // 65 tabs = 5488 MB). Tabs also linger — sessions reuse names but rarely close
  // pages, so a sweep that opens a tab per URL can leave GBs resident in the
  // SHARED browser, hurting every other session. Cap what one project can hold.
  // Override per-server with DEV_BROWSER_MAX_PAGES.
  MAX_PAGES_PER_PROJECT: Number(process.env.DEV_BROWSER_MAX_PAGES ?? 5),
  RETRY_DELAY: 500,
  MAX_TEXT_LENGTH: 30,
  MAX_VALUE_LENGTH: 20,
  MAX_SRC_LENGTH: 60,
  MAX_IFRAMES: 5,
  MAX_BUTTONS: 8,
  MAX_INPUTS: 10,
  MAX_LINKS: 15,
} as const;

const DEFAULT_CDP_PORT = 9223;
const DEFAULT_USER_CDP_PORT = 9222;
const MAX_PORT = 65535;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY = 500;

// ── Focus preservation (macOS, headful only) ────────────────────
// Creating a tab in a HEADFUL Chromium activates the app and yanks focus away
// from whatever the human is typing into. Measured on macOS: reusing an existing
// page steals nothing, creating a tab makes "Google Chrome for Testing"
// frontmost. Nothing in this codebase calls bringToFront() — Chromium does it on
// its own, and there is no flag to disable it. So we note who was frontmost
// before creating a tab and hand focus straight back afterwards.
// Best-effort by design: never blocks or fails page creation.
const isMac = process.platform === "darwin";

async function frontmostApp(): Promise<string | undefined> {
  if (!isMac) return undefined;
  return new Promise<string | undefined>((resolve): void => {
    execFile(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      (err: unknown, stdout: string): void => {
        resolve(err ? undefined : stdout.trim() || undefined);
      },
    );
  });
}

function restoreFocus(appName: string | undefined): void {
  // Chromium legitimately being frontmost before is a no-op worth skipping.
  if (!isMac || !appName || appName.startsWith("Google Chrome")) return;
  execFile("osascript", ["-e", `tell application "${appName.replace(/"/g, "")}" to activate`], (): void => {
    // best-effort: the app may have quit, or lack automation permission
  });
}

// Helper to retry fetch with exponential backoff
async function fetchWithRetry(
  url: string,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  delayMilliseconds: number = DEFAULT_RETRY_DELAY
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
        await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, delayMilliseconds * (i + 1)); });
      }
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
}

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_: unknown, reject: (reason: Error) => void): void => {
      setTimeout((): void => { reject(new Error(`Timeout: ${message}`)); }, milliseconds);
    }),
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
  const port = options.port ?? DEFAULT_USER_CDP_PORT;
  const headless = options.headless ?? false;
  const cdpPort = options.cdpPort ?? DEFAULT_CDP_PORT;
  const profileDir = options.profileDir;
  const browserMode = options.browserMode ?? "dev";
  const userCdpPort = options.userCdpPort ?? DEFAULT_USER_CDP_PORT; // Default user Chrome CDP port

  console.log(`Browser mode: ${browserMode}`);

  // Validate port numbers
  if (port < 1 || port > MAX_PORT) {
    throw new Error(`Invalid port: ${port}. Must be between 1 and 65535`);
  }
  if (browserMode !== "user" && (cdpPort < 1 || cdpPort > MAX_PORT)) {
    throw new Error(`Invalid cdpPort: ${cdpPort}. Must be between 1 and 65535`);
  }
  if (browserMode !== "user" && port === cdpPort) {
    throw new Error("port and cdpPort must be different");
  }

  let context: BrowserContext;
  let wsEndpoint: string;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  let userConn: CDPConnection | null = null;

  // Reusable launcher for dev/stealth modes — called on startup and after browser crash
  // Never fall back to process.cwd() — that scatters .browser-data (and stale
  // Singleton locks) into whatever project dir the server was launched from.
  // Default to the canonical DEV_BROWSER_HOME/profiles/<mode> instead.
  const userDataDir = (browserMode !== "user")
    ? (profileDir
        ? join(profileDir, "browser-data")
        : join(process.env.DEV_BROWSER_HOME || join(process.env.HOME || "/tmp", ".dev-browser"), "profiles", browserMode, "browser-data"))
    : "";

  async function launchBrowserContext(): Promise<void> {
    if (browserMode !== "user") {
      mkdirSync(userDataDir, { recursive: true });
      fixChromePreferences(userDataDir);
      // Clear stale Singleton locks left by a crashed Chromium — otherwise
      // launchPersistentContext fails/hangs with "profile appears to be in use".
      for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        try { rmSync(join(userDataDir, lock), { force: true }); } catch { void 0; }
      }
      console.log("Launching browser with persistent context...");
      context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        args: [
          `--remote-debugging-port=${cdpPort}`,
          "--use-mock-keychain", // silence macOS keychain noise (userCanceledErr -128)
          "--restore-last-session",
          "--disable-session-crashed-bubble",
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
  }

  // Check if context is alive; if dead, kill stale Chrome and relaunch (dev/stealth only)
  async function ensureContext(): Promise<void> {
    if (browserMode === "user") return;
    try {
      // Quick liveness check — if context is closed this throws
      await context.pages();
    } catch { void 0; /* best-effort: browser context dead, relaunching below */
      console.log("Browser context is dead — relaunching...");
      registry.clear();
      // Kill stale Chrome processes holding CDP port before relaunch
      try {
        const { execSync } = await import("child_process");
        // Use fuser instead of lsof (lsof hangs on macOS)
        execSync(`kill -9 $(fuser ${cdpPort}/tcp 2>/dev/null) 2>/dev/null`, { stdio: "ignore", timeout: TIMEOUTS.SHORT });
        await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, TIMEOUTS.STALE_PROCESS_KILL); });
      } catch { void 0; /* cleanup: no stale processes to kill */ }
      await launchBrowserContext();
      // Verify the relaunched browser is actually functional before declaring
      // success — never advertise "ready" with a dead/zero-process context.
      // context.pages() throws if Chromium died immediately after launch.
      await context.pages();
      console.log("Browser relaunched successfully");
    }
  }

  if (browserMode === "user") {
    // HARD SAFETY GATE: --user attaches to the user's REAL Brave on :9222. After
    // repeated accidental tab/window loss, attaching to the primary browser is OFF
    // by default and requires an EXPLICIT opt-in (--allow-primary / env). This is
    // the single chokepoint for every attach path (wrapper OR direct tsx).
    if (process.env.DEV_BROWSER_ALLOW_PRIMARY !== "1") {
      console.error("\n=== USER MODE BLOCKED (safety) ===");
      console.error("--user drives your REAL Brave on port 9222. To prevent accidental");
      console.error("tab loss it is now OFF unless you explicitly ask for it:");
      console.error("");
      console.error("    dev-browser.sh --user --allow-primary --server");
      console.error("    (or set DEV_BROWSER_ALLOW_PRIMARY=1)");
      console.error("");
      console.error("Even when enabled, dev-browser only ever closes tabs IT created.");
      console.error("==================================\n");
      throw new Error("user mode is disabled by default — pass --allow-primary (DEV_BROWSER_ALLOW_PRIMARY=1) to opt in");
    }

    // USER MODE: Connect to user's existing Chrome browser
    console.log(`Connecting to user's Chrome on CDP port ${userCdpPort}...`);
    console.log("(Make sure Chrome is running with: --remote-debugging-port=9222)");

    try {
      const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${userCdpPort}/json/version`);
      const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
      wsEndpoint = cdpInfo.webSocketDebuggerUrl;

      // Raw CDP single-target driver — NOT Playwright's connectOverCDP, which
      // force-attaches to every target in the user's heavy live profile and
      // hangs forever (see cdp-page.ts header). We attach only to tabs we create.
      userConn = await CDPConnection.connect(wsEndpoint);
      context = makeUserContext(userConn) as unknown as BrowserContext;
      console.log("Connected to user's browser via raw CDP (single-target mode — your existing tabs are untouched)");
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
    console.log(`Using persistent browser profile: ${userDataDir}`);
    await launchBrowserContext();

    // Close all pre-existing pages from session restore — registry is empty,
    // so these are orphans from previous server runs. Sessions will create fresh pages.
    try {
      const restoredPages = context.pages();
      if (restoredPages.length > 0) {
        console.log(`Closing ${restoredPages.length} restored tab(s) from previous session...`);
        for (const restoredPage of restoredPages) {
          try { await restoredPage.close(); } catch { void 0; /* cleanup: page already closed */ }
        }
      }
    } catch { void 0; /* best-effort: context may not support pages() yet */ }
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

  // Helper to get CDP targetId for a page (with timeout to prevent hangs)
  async function getTargetId(page: Page): Promise<string> {
    // User mode: CDPPage already knows its targetId (it created the tab).
    if (browserMode === "user") return (page as unknown as { targetId: string }).targetId;
    return withTimeout((async (): Promise<string> => {
      const cdpSession = await context.newCDPSession(page);
      try {
        const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
        return targetInfo.targetId;
      } finally {
        await cdpSession.detach();
      }
    })(), TIMEOUTS.MEDIUM, "getTargetId timed out after 10s");
  }

  // Express server for page management
  const app: Express = express();
  app.use(express.json());

  // GET / - server info
  app.get("/", (_req: Request, res: Response): void => {
    const response: ServerInfoResponse = { wsEndpoint };
    res.json(response);
  });

  // GET /health - quick health check (verifies browser context is alive)
  app.get("/health", async (_req: Request, res: Response): Promise<void> => {
    try {
      // Verify context is actually functional, not just that Express is running
      await context.pages();
      res.status(HTTP.OK).send("ok");
    } catch { void 0; /* best-effort: browser context is dead */
      res.status(HTTP.SERVICE_UNAVAILABLE).send("browser-dead");
    }
  });

  // GET /pages - list all pages
  app.get("/pages", (_req: Request, res: Response): void => {
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
  app.post("/pages", async (req: Request, res: Response): Promise<void> => {
    const body = req.body as GetPageRequest;
    const { name } = body;

    if (!name || typeof name !== "string") {
      res.status(HTTP.BAD_REQUEST).json({ error: "name is required and must be a string" });
      return;
    }

    if (name.length === 0) {
      res.status(HTTP.BAD_REQUEST).json({ error: "name cannot be empty" });
      return;
    }

    if (name.length > LIMITS.MAX_PAGE_NAME) {
      res.status(HTTP.BAD_REQUEST).json({ error: "name must be 256 characters or less" });
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
        await entry.page.evaluate((): boolean => true).catch(async (): Promise<void> => {
          // Page might be mid-navigation — wait briefly and retry once
          await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, LIMITS.RETRY_DELAY); });
          if (entry!.page.isClosed()) throw new Error("page closed");
          await entry!.page.evaluate((): boolean => true);
        });
      } catch { void 0; /* selector: page is stale, will recreate below */
        // Page is truly dead/closed — remove stale entry and recreate
        console.log(`Page "${name}" was stale, recreating...`);
        registry.delete(name);
        entry = undefined;
      }
    }
    if (!entry) {
      // TAB CAP — only on the CREATE path. Reusing an existing page is never
      // blocked, so a capped project can still work indefinitely with the tabs
      // it already holds; only *growing* the footprint is refused.
      // Refuse rather than evict: closing someone's oldest tab could destroy
      // work in flight. A refusal is recoverable, a wrong eviction is not.
      const { project } = body;
      if (project) {
        const owned = Array.from(registry.keys()).filter((n: string): boolean =>
          n.startsWith(`${project}-`),
        );
        if (owned.length >= LIMITS.MAX_PAGES_PER_PROJECT) {
          res.status(HTTP.TOO_MANY_REQUESTS).json({
            error:
              `Tab limit reached: project "${project}" already holds ${String(owned.length)} pages ` +
              `(limit ${String(LIMITS.MAX_PAGES_PER_PROJECT)}): ${owned.join(", ")}. ` +
              `Each open tab costs ~85MB in the SHARED browser, so close what you finished with:\n` +
              `  dev-browser.sh --cleanup --mine        # close this project's pages\n` +
              `  await client.close("<name>")           # close one from a script\n` +
              `Reuse an existing page name instead of opening another, or raise the cap with ` +
              `DEV_BROWSER_MAX_PAGES=N when starting the server.`,
            pages: owned,
            limit: LIMITS.MAX_PAGES_PER_PROJECT,
          });
          return;
        }
      }
      // Ensure browser context is alive (auto-relaunch if crashed)
      await ensureContext();
      // Note who has focus BEFORE the tab exists — creating it will steal focus
      // in headful mode (see frontmostApp/restoreFocus). Headless steals nothing,
      // so don't pay for the check.
      const focusedBefore = headless ? undefined : await frontmostApp();
      // Create new page in the persistent context (with timeout to prevent hangs)
      const page = await withTimeout(context.newPage(), TIMEOUTS.LONG, "Page creation timed out after 30s");
      restoreFocus(focusedBefore);

      // Register early to protect from cleanup_orphaned_tabs race:
      // the cleanup checks registry before closing any tab, so we must
      // register before doing any async work (stealth injection, etc.)
      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(name, entry);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", (): void => {
        stopIdleMovement(page);
        registry.delete(name);
      });

      // Inject stealth scripts for stealth mode (after registration)
      await injectStealthScripts(page);

      // Start idle mouse jitter in stealth mode
      if (browserMode === "stealth") {
        startIdleMovement(page);
      }
    }

    // Debug: log what we're returning
    try {
      const url = entry.page.url();
      console.log(`POST /pages "${name}" → targetId=${entry.targetId}, url=${url}`);
    } catch { void 0; /* best-effort: page may have been closed during logging */ }

    const response: GetPageResponse = { wsEndpoint, name, targetId: entry.targetId };
    res.json(response);
  });

  // DELETE /pages/:name - close a page
  app.delete("/pages/:name", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (entry) {
      try {
        await withTimeout(entry.page.close(), TIMEOUTS.MEDIUM, "page.close() timed out after 10s");
      } catch { void 0; /* cleanup: force-remove from registry even if close hangs */ }
      registry.delete(name);
      res.json({ success: true });
      return;
    }

    res.status(HTTP.NOT_FOUND).json({ error: "page not found" });
  });

  // POST /pages/:name/screenshot - take screenshot using server's Page object
  // This avoids stale CDP reconnection issues
  app.post("/pages/:name/screenshot", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(HTTP.NOT_FOUND).json({ error: `Page "${name}" not found` });
      return;
    }

    try {
      const { path: savePath, fullPage, selector } = req.body as { path?: string; fullPage?: boolean; selector?: string };
      const screenshotPath = savePath || `/tmp/screenshot-${Date.now()}.png`;
      if (selector) {
        // Element-level screenshot: scroll into view + clip to element bounds
        const locator = entry.page.locator(selector).first();
        await locator.scrollIntoViewIfNeeded({ timeout: TIMEOUTS.SHORT });
        await locator.screenshot({ path: screenshotPath });
      } else {
        await entry.page.screenshot({ path: screenshotPath, fullPage: fullPage !== false });
      }
      const url = entry.page.url();
      const viewport = entry.page.viewportSize() ?? await entry.page.evaluate((): { width: number; height: number } => ({ width: window.innerWidth, height: window.innerHeight })).catch((): null => null);
      const vpStr = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
      console.log(`Screenshot "${name}" → ${screenshotPath} (url=${url}${selector ? `, selector=${selector}` : ''})`);
      res.json({ success: true, path: screenshotPath, url, viewport: vpStr });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(HTTP.SERVER_ERROR).json({ error: msg });
    }
  });

  // POST /pages/:name/aria - get ARIA accessibility snapshot using server's Page object
  // This avoids client-side connectOverCDP which can timeout on heavy pages
  app.post("/pages/:name/aria", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(HTTP.NOT_FOUND).json({ error: `Page "${name}" not found` });
      return;
    }

    try {
      const snapshotScript = getSnapshotScript();
      const snapshot = await withTimeout(entry.page.evaluate((script: string): any => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const globals = globalThis as any;
        if (!globals.__devBrowser_getAISnapshot) {
          // eslint-disable-next-line no-eval
          eval(script);
        }
        return globals.__devBrowser_getAISnapshot();
      }, snapshotScript), TIMEOUTS.LONG, "ARIA snapshot timed out after 30s");
      res.json({ success: true, snapshot });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(HTTP.SERVER_ERROR).json({ error: msg });
    }
  });

  // POST /pages/:name/evaluate - evaluate JS using server's Page object
  app.post("/pages/:name/evaluate", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(HTTP.NOT_FOUND).json({ error: `Page "${name}" not found` });
      return;
    }

    try {
      const { code } = req.body as { code: string };
      const result = await withTimeout(entry.page.evaluate((script: string): any => {
        try {
          const fn = new Function(`return (${script})`);
          const fnResult = fn();
          if (fnResult && typeof fnResult.then === 'function') {
            return fnResult.then((resolved: unknown): { success: boolean; result: unknown } => ({ success: true, result: resolved }));
          }
          return { success: true, result: fnResult };
        } catch { void 0; /* selector: expression failed, try as statement */
          try { const fn = new Function(script); fn(); return { success: true, result: undefined }; }
          catch (execError: unknown) { return { success: false, error: execError instanceof Error ? execError.message : String(execError) }; }
        }
      }, code), TIMEOUTS.LONG, "page.evaluate() timed out after 30s");
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(HTTP.SERVER_ERROR).json({ success: false, error: msg });
    }
  });

  // POST /pages/:name/resize - resize viewport using server's Page object
  app.post("/pages/:name/resize", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(HTTP.NOT_FOUND).json({ error: `Page "${name}" not found` });
      return;
    }

    try {
      const { width, height } = req.body as { width: number; height: number };
      if (!width || !height) {
        res.status(HTTP.BAD_REQUEST).json({ error: "width and height are required" });
        return;
      }
      await entry.page.setViewportSize({ width, height });
      const viewport = entry.page.viewportSize();
      console.log(`Resize "${name}" → ${viewport?.width}x${viewport?.height}`);
      res.json({ success: true, width: viewport?.width, height: viewport?.height });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(HTTP.SERVER_ERROR).json({ error: msg });
    }
  });

  // POST /cookies - inject cookies into browser context via Playwright addCookies()
  // Uses context-level API which properly handles domain matching, secure flags, httpOnly
  app.post("/cookies", async (req: Request, res: Response): Promise<void> => {
    try {
      const { cookies } = req.body as { cookies: Array<Record<string, unknown>> };
      if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
        res.status(HTTP.BAD_REQUEST).json({ error: "cookies array is required and must not be empty" });
        return;
      }

      // Convert Chrome extension cookie format to Playwright format
      const playwrightCookies = cookies.map((cookieData: Record<string, unknown>): Record<string, unknown> => {
        const cookie: Record<string, unknown> = {
          name: String(cookieData.name || ""),
          value: String(cookieData.value || ""),
          domain: String(cookieData.domain || ""),
          path: String(cookieData.path || "/"),
        };
        if (cookieData.expirationDate && Number(cookieData.expirationDate) > 0) {
          cookie.expires = Number(cookieData.expirationDate);
        }
        if (cookieData.httpOnly !== undefined) cookie.httpOnly = Boolean(cookieData.httpOnly);
        if (cookieData.secure !== undefined) cookie.secure = Boolean(cookieData.secure);
        if (cookieData.sameSite) {
          // Chrome uses lowercase, Playwright uses capitalized
          const sameSite = String(cookieData.sameSite).toLowerCase();
          if (sameSite === "strict") cookie.sameSite = "Strict";
          else if (sameSite === "lax") cookie.sameSite = "Lax";
          else if (sameSite === "none") cookie.sameSite = "None";
        }
        return cookie;
      });

      await context.addCookies(playwrightCookies as Parameters<typeof context.addCookies>[0]);
      console.log(`Injected ${playwrightCookies.length} cookies (domains: ${[...new Set(playwrightCookies.map((cookieData: Record<string, unknown>): unknown => cookieData.domain))].join(", ")})`);
      res.json({ success: true, count: playwrightCookies.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(HTTP.SERVER_ERROR).json({ error: msg });
    }
  });

  // GET /pages/:name/url - get current page URL from server's Page object
  app.get("/pages/:name/url", (req: Request<{ name: string }>, res: Response): void => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(HTTP.NOT_FOUND).json({ error: `Page "${name}" not found` });
      return;
    }

    try {
      res.json({ url: entry.page.url(), name });
    } catch { void 0; /* navigation: page may have been closed */
      registry.delete(name);
      res.status(HTTP.GONE).json({ error: `Page "${name}" was closed` });
    }
  });

  // ── Fast-path endpoints (skip tsx) ──────────────────────────────

  // Helper: get page entry or 404
  const getPageEntry = (req: Request<{ name: string }>, res: Response): { name: string; entry: PageEntry } | null => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);
    if (!entry) {
      res.status(HTTP.NOT_FOUND).json({ error: `Page "${name}" not found` });
      return null;
    }
    return { name, entry };
  };

  // POST /pages/:name/goto - navigate to URL
  app.post("/pages/:name/goto", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      let { url, cachebust } = req.body as { url: string; cachebust?: boolean };
      if (!url) { res.status(HTTP.BAD_REQUEST).json({ error: "url is required" }); return; }
      if (cachebust && url !== "about:blank") {
        const sep = url.includes("?") ? "&" : "?";
        url = `${url}${sep}v=${Date.now()}`;
      }
      try {
        await entry.page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.LONG });
      } catch (navigationError: unknown) {
        // Fail fast on connection errors instead of waiting for full timeout
        const msg = navigationError instanceof Error ? navigationError.message : String(navigationError);
        if (msg.includes("ERR_CONNECTION_REFUSED") || msg.includes("ERR_CONNECTION_RESET") || msg.includes("ERR_NAME_NOT_RESOLVED") || msg.includes("ERR_ADDRESS_UNREACHABLE")) {
          res.status(HTTP.BAD_GATEWAY).json({ error: msg.split("\n")[0] });
          return;
        }
        throw navigationError;
      }
      try { await entry.page.waitForLoadState("networkidle", { timeout: TIMEOUTS.MEDIUM }); } catch { void 0; /* best-effort: proceed if network idle times out */ }

      const pageState = await entry.page.evaluate((limits: any): string => {
        const doc = document;
        const lines: string[] = [];
        // Forms summary
        doc.querySelectorAll("form").forEach((form: any): void => {
          const id = form.id || form.getAttribute("name") || "(unnamed)";
          const fields: string[] = [];
          form.querySelectorAll("input, select, textarea").forEach((element: any): void => {
            const inp = element as HTMLInputElement;
            const name = inp.name || inp.id || inp.placeholder || inp.type;
            if (name && inp.type !== "hidden") fields.push(`${name}[${inp.type || element.tagName.toLowerCase()}]`);
          });
          if (fields.length > 0) lines.push(`Form #${id}: ${fields.join(", ")}`);
        });
        // Standalone inputs
        const standalone: string[] = [];
        doc.querySelectorAll("input:not(form input), select:not(form select), textarea:not(form textarea)").forEach((element: any): void => {
          const inp = element as HTMLInputElement;
          const name = inp.name || inp.id || inp.placeholder || inp.type;
          if (name && inp.type !== "hidden") standalone.push(`${name}[${inp.type || element.tagName.toLowerCase()}]`);
        });
        if (standalone.length > 0) lines.push(`Inputs: ${standalone.slice(0, limits.maxInputs).join(", ")}`);
        // Buttons
        const buttons: string[] = [];
        doc.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((element: any): void => {
          const text = (element.textContent || (element as HTMLInputElement).value || "").trim().substring(0, limits.maxText);
          if (text && !buttons.includes(text)) buttons.push(text);
        });
        if (buttons.length > 0) lines.push(`Buttons: ${buttons.slice(0, limits.maxButtons).join(", ")}`);
        // Iframes
        const iframes = doc.querySelectorAll("iframe");
        if (iframes.length > 0) {
          const info = Array.from(iframes).slice(0, limits.maxIframes).map((frame: any): string => {
            const name = frame.name || frame.id || "";
            const src = frame.src?.substring(0, limits.maxSrc) || "";
            return name ? `${name}(${src})` : src;
          }).filter(Boolean);
          if (info.length > 0) lines.push(`Iframes: ${info.join(", ")}`);
        }
        // Links
        const links: string[] = [];
        const seen = new Set<string>();
        doc.querySelectorAll("a[href]").forEach((element: any): void => {
          const text = (element.textContent || "").trim().substring(0, limits.maxText);
          const href = element.getAttribute("href") || "";
          if (text && !seen.has(text) && href !== "#" && !href.startsWith("javascript:") && !href.startsWith("mailto:")) {
            seen.add(text);
            links.push(text);
          }
        });
        if (links.length > 0) lines.push(`Links: ${links.slice(0, limits.maxLinks).join(", ")}`);
        return lines.join("\n");
      }, { maxText: LIMITS.MAX_TEXT_LENGTH, maxInputs: LIMITS.MAX_INPUTS, maxButtons: LIMITS.MAX_BUTTONS, maxIframes: LIMITS.MAX_IFRAMES, maxSrc: LIMITS.MAX_SRC_LENGTH, maxLinks: LIMITS.MAX_LINKS });
      res.json({ url: entry.page.url(), title: await entry.page.title(), state: pageState });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/click - click element by text, ARIA ref, or CSS selector
  app.post("/pages/:name/click", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      const { target, force } = req.body as { target: string; force?: boolean };
      if (!target) { res.status(HTTP.BAD_REQUEST).json({ error: "target is required" }); return; }

      let clickedType = "";
      let clicked = false;

      // Force click helper - dispatches JS events directly (bypasses actionability)
      const forceClickHandle = async (handle: import("playwright").ElementHandle): Promise<void> => {
        await handle.evaluate((node: any): void => {
          node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          if (typeof node.click === 'function') node.click();
        });
      };

      // ARIA ref click (e.g., e1, e5, e123) — uses server-side page object, no connectOverCDP
      if (/^e\d+$/.test(target)) {
        const elementHandle = await entry.page.evaluateHandle((refId: string): any => {
          const globals = globalThis as any;
          const refs = globals.__devBrowserRefs;
          if (!refs) throw new Error("No snapshot refs found. Run 'aria' first.");
          const element = refs[refId];
          if (!element) throw new Error(`Ref "${refId}" not found. Available: ${Object.keys(refs).join(", ")}`);
          return element;
        }, target);
        const element = elementHandle.asElement();
        if (!element) {
          await elementHandle.dispose();
          res.status(HTTP.NOT_FOUND).json({ error: `Ref '${target}' did not resolve to an element. Run 'aria' to refresh.` });
          return;
        }
        if (force) {
          await forceClickHandle(element);
        } else {
          await element.click();
        }
        await elementHandle.dispose();
        clickedType = "ref";
        clicked = true;
        // Wait for navigation/load
        try { await entry.page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.SHORT }); } catch { void 0; /* best-effort: proceed if load state times out */ }
        const clickState = await entry.page.evaluate((limits: any): string => {
          const doc = document;
          const lines: string[] = [];
          doc.querySelectorAll("form").forEach((form: any): void => {
            const id = form.id || form.getAttribute("name") || "(unnamed)";
            const fields: string[] = [];
            form.querySelectorAll("input, select, textarea").forEach((element: any): void => {
              const inp = element as HTMLInputElement;
              const name = inp.name || inp.id || inp.placeholder || inp.type;
              if (name && inp.type !== "hidden") fields.push(`${name}[${inp.type || element.tagName.toLowerCase()}]`);
            });
            if (fields.length > 0) lines.push(`Form #${id}: ${fields.join(", ")}`);
          });
          const buttons: string[] = [];
          doc.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((element: any): void => {
            const text = (element.textContent || (element as HTMLInputElement).value || "").trim().substring(0, limits.maxText);
            if (text && !buttons.includes(text)) buttons.push(text);
          });
          if (buttons.length > 0) lines.push(`Buttons: ${buttons.slice(0, limits.maxButtons).join(", ")}`);
          return lines.join("\n");
        }, { maxText: LIMITS.MAX_TEXT_LENGTH, maxButtons: LIMITS.MAX_BUTTONS });
        res.json({ clicked: target, type: clickedType, url: entry.page.url(), title: await entry.page.title(), state: clickState });
        return;
      }

      // Human mouse movement helper for stealth mode
      const stealthMoveToLocator = async (locator: import("playwright").Locator): Promise<void> => {
        if (browserMode !== "stealth") return;
        try {
          const center = await getElementCenter(locator);
          await humanMouseMove(entry.page, center.x, center.y);
          await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, LIMITS.MOUSE_IDLE + Math.random() * LIMITS.MOUSE_JITTER); });
        } catch { void 0; /* best-effort: element may not be visible yet */ }
      };

      // Try button role
      try { const loc = entry.page.getByRole("button", { name: target }); await stealthMoveToLocator(loc); await loc.click({ timeout: TIMEOUTS.NAVIGATION }); clickedType = "button"; clicked = true; } catch { void 0; /* selector: try next matching strategy */ }
      // Try link role
      if (!clicked) { try { const loc = entry.page.getByRole("link", { name: target }); await stealthMoveToLocator(loc); await loc.click({ timeout: TIMEOUTS.NAVIGATION }); clickedType = "link"; clicked = true; } catch { void 0; /* selector: try next matching strategy */ } }
      // Try frames
      if (!clicked) {
        for (const frame of entry.page.frames()) {
          if (clicked) break;
          try { const loc = frame.getByRole("button", { name: target }); await loc.click({ timeout: TIMEOUTS.SETTLE }); clickedType = "button (frame)"; clicked = true; } catch { void 0; /* selector: try next matching strategy */
            try { const loc = frame.getByRole("link", { name: target }); await loc.click({ timeout: TIMEOUTS.SETTLE }); clickedType = "link (frame)"; clicked = true; } catch { void 0; /* selector: try next matching strategy */ }
          }
        }
      }
      // Iframe coordinate-based click fallback (for reCAPTCHA/Turnstile checkboxes)
      if (!clicked) {
        try {
          // Find iframes that contain matching text
          for (const frame of entry.page.frames()) {
            if (clicked) break;
            try {
              const hasText = await frame.locator(`text=${target}`).count();
              if (hasText > 0) {
                // Get the iframe element's bounding box from the parent page
                const frameUrl = frame.url();
                const iframeLoc = entry.page.locator(`iframe[src*="${new URL(frameUrl).hostname}"]`).first();
                const iframeBox = await Promise.race([
                  iframeLoc.boundingBox(),
                  new Promise<null>((resolve: (value: null) => void): void => { setTimeout((): void => { resolve(null); }, TIMEOUTS.SETTLE); }),
                ]);
                if (iframeBox) {
                  // Click near the checkbox area (typically ~28px from left, center vertically, capped at 28px from top)
                  const clickX = iframeBox.x + LIMITS.CAPTCHA_OFFSET;
                  const clickY = iframeBox.y + Math.min(iframeBox.height / 2, LIMITS.CAPTCHA_OFFSET);
                  if (browserMode === "stealth") {
                    await humanMouseMove(entry.page, clickX, clickY);
                    await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, LIMITS.MOUSE_IDLE + Math.random() * LIMITS.MOUSE_JITTER); });
                  }
                  await entry.page.mouse.click(clickX, clickY);
                  clickedType = "iframe-coordinates";
                  clicked = true;
                }
              }
            } catch { void 0; /* best-effort: frame may be detached */ }
          }
        } catch { void 0; /* best-effort: iframe coordinate click failed */ }
      }
      // CSS selector fallback
      if (!clicked) { const loc = entry.page.locator(target).first(); await stealthMoveToLocator(loc); await loc.click({ timeout: TIMEOUTS.SHORT }); clickedType = "selector"; }

      try { await entry.page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.SHORT }); } catch { void 0; /* best-effort: proceed if load state times out */ }
      const clickState = await entry.page.evaluate((limits: any): string => {
        const doc = document;
        const lines: string[] = [];
        doc.querySelectorAll("form").forEach((form: any): void => {
          const id = form.id || form.getAttribute("name") || "(unnamed)";
          const fields: string[] = [];
          form.querySelectorAll("input, select, textarea").forEach((element: any): void => {
            const inp = element as HTMLInputElement;
            const name = inp.name || inp.id || inp.placeholder || inp.type;
            if (name && inp.type !== "hidden") fields.push(`${name}[${inp.type || element.tagName.toLowerCase()}]`);
          });
          if (fields.length > 0) lines.push(`Form #${id}: ${fields.join(", ")}`);
        });
        const buttons: string[] = [];
        doc.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((element: any): void => {
          const text = (element.textContent || (element as HTMLInputElement).value || "").trim().substring(0, limits.maxText);
          if (text && !buttons.includes(text)) buttons.push(text);
        });
        if (buttons.length > 0) lines.push(`Buttons: ${buttons.slice(0, limits.maxButtons).join(", ")}`);
        return lines.join("\n");
      }, { maxText: LIMITS.MAX_TEXT_LENGTH, maxButtons: LIMITS.MAX_BUTTONS });
      res.json({ clicked: target, type: clickedType, url: entry.page.url(), title: await entry.page.title(), state: clickState });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/mouse-click - click at viewport coordinates (for iframe content like CAPTCHAs)
  app.post("/pages/:name/mouse-click", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      const { x, y } = req.body as { x: number; y: number };
      if (typeof x !== "number" || typeof y !== "number") { res.status(HTTP.BAD_REQUEST).json({ error: "x and y coordinates are required" }); return; }
      if (browserMode === "stealth") {
        await humanMouseMove(entry.page, x, y);
        await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, LIMITS.MOUSE_IDLE + Math.random() * LIMITS.MOUSE_JITTER); });
      }
      await entry.page.mouse.click(x, y);
      res.json({ clicked: { x, y }, url: entry.page.url() });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/fill - fill form field by name/id/label/selector/ARIA ref
  app.post("/pages/:name/fill", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      const { target, value } = req.body as { target: string; value: string };
      if (!target || value === undefined) { res.status(HTTP.BAD_REQUEST).json({ error: "target and value are required" }); return; }

      let filled = false;
      let filledWith = "";

      // ARIA ref fill (e.g., e1, e5) — uses server-side page object, no connectOverCDP
      if (/^e\d+$/.test(target)) {
        const elementHandle = await entry.page.evaluateHandle((refId: string): any => {
          const globals = globalThis as any;
          const refs = globals.__devBrowserRefs;
          if (!refs) throw new Error("No snapshot refs found. Run 'aria' first.");
          const element = refs[refId];
          if (!element) throw new Error(`Ref "${refId}" not found. Available: ${Object.keys(refs).join(", ")}`);
          return element;
        }, target);
        const element = elementHandle.asElement();
        if (!element) {
          await elementHandle.dispose();
          res.status(HTTP.NOT_FOUND).json({ error: `Ref '${target}' did not resolve to an element. Run 'aria' to refresh.` });
          return;
        }
        // Determine element type and fill appropriately
        const tagInfo = await element.evaluate((node: any): { tag: string; type: string; isContentEditable: boolean } => ({
          tag: node.tagName.toLowerCase(),
          type: node.type?.toLowerCase() || "",
          isContentEditable: node.isContentEditable,
        }));
        if (tagInfo.tag === "select") {
          await element.evaluate((node: any, val: string): void => {
            // Try by value first, then by visible text
            const byValue: any = Array.from(node.options).find((option: any): boolean => option.value === val);
            const byText: any = Array.from(node.options).find((option: any): boolean => option.textContent?.trim() === val);
            const option: any = byValue || byText;
            if (option) { node.value = option.value; node.dispatchEvent(new Event('change', { bubbles: true })); }
          }, value);
          filledWith = "ref (select)";
        } else if (tagInfo.type === "checkbox" || tagInfo.type === "radio") {
          const shouldCheck = value === "true" || value === "1" || value === "on" || value === "yes";
          await element.evaluate((node: any, check: boolean): void => {
            if (node.checked !== check) { node.click(); }
          }, shouldCheck);
          filledWith = `ref (${tagInfo.type})`;
        } else {
          // Text input / textarea / contenteditable
          await element.click();
          await element.evaluate((node: any): void => { node.value = ""; node.dispatchEvent(new Event('input', { bubbles: true })); });
          await element.type(value);
          filledWith = "ref (type)";
        }
        await elementHandle.dispose();
        filled = true;
        const fillState = await entry.page.evaluate((limits: any): string => {
          const doc = document;
          const lines: string[] = [];
          doc.querySelectorAll("form").forEach((form: any): void => {
            const id = form.id || form.getAttribute("name") || "(unnamed)";
            const fields: string[] = [];
            form.querySelectorAll("input, select, textarea").forEach((element: any): void => {
              const inp = element as HTMLInputElement;
              const name = inp.name || inp.id || inp.placeholder || inp.type;
              if (name && inp.type !== "hidden") {
                const val = inp.value ? ` ="${inp.value.substring(0, limits.maxValue)}"` : "";
                fields.push(`${name}[${inp.type || element.tagName.toLowerCase()}]${val}`);
              }
            });
            if (fields.length > 0) lines.push(`Form #${id}: ${fields.join(", ")}`);
          });
          const buttons: string[] = [];
          doc.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((element: any): void => {
            const text = (element.textContent || (element as HTMLInputElement).value || "").trim().substring(0, limits.maxText);
            if (text && !buttons.includes(text)) buttons.push(text);
          });
          if (buttons.length > 0) lines.push(`Buttons: ${buttons.slice(0, limits.maxButtons).join(", ")}`);
          return lines.join("\n");
        }, { maxText: LIMITS.MAX_TEXT_LENGTH, maxButtons: LIMITS.MAX_BUTTONS, maxValue: LIMITS.MAX_VALUE_LENGTH });
        res.json({ filled: target, value, selector: filledWith, state: fillState });
        return;
      }

      // Human mouse movement helper for stealth mode
      const stealthMoveToElement = async (locator: import("playwright").Locator): Promise<void> => {
        if (browserMode !== "stealth") return;
        try {
          const center = await getElementCenter(locator);
          await humanMouseMove(entry.page, center.x, center.y);
          await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, LIMITS.MOUSE_IDLE + Math.random() * LIMITS.MOUSE_JITTER); });
        } catch { void 0; /* best-effort: element may not be visible */ }
      };

      const resolved = await resolveField(entry.page, target);
      if (!resolved) { res.status(HTTP.NOT_FOUND).json({ error: `Field '${target}' not found` }); return; }
      await stealthMoveToElement(resolved.locator);
      const action = await smartFill(resolved, value);
      filledWith = `${resolved.matchedBy} (${action})`; filled = true;

      // Include current form values in response
      const fillState = await entry.page.evaluate((limits: any): string => {
        const doc = document;
        const lines: string[] = [];
        doc.querySelectorAll("form").forEach((form: any): void => {
          const id = form.id || form.getAttribute("name") || "(unnamed)";
          const fields: string[] = [];
          form.querySelectorAll("input, select, textarea").forEach((element: any): void => {
            const inp = element as HTMLInputElement;
            const name = inp.name || inp.id || inp.placeholder || inp.type;
            if (name && inp.type !== "hidden") {
              const val = inp.value ? ` ="${inp.value.substring(0, limits.maxValue)}"` : "";
              fields.push(`${name}[${inp.type || element.tagName.toLowerCase()}]${val}`);
            }
          });
          if (fields.length > 0) lines.push(`Form #${id}: ${fields.join(", ")}`);
        });
        const buttons: string[] = [];
        doc.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((element: any): void => {
          const text = (element.textContent || (element as HTMLInputElement).value || "").trim().substring(0, limits.maxText);
          if (text && !buttons.includes(text)) buttons.push(text);
        });
        if (buttons.length > 0) lines.push(`Buttons: ${buttons.slice(0, limits.maxButtons).join(", ")}`);
        return lines.join("\n");
      }, { maxText: LIMITS.MAX_TEXT_LENGTH, maxButtons: LIMITS.MAX_BUTTONS, maxValue: LIMITS.MAX_VALUE_LENGTH });
      res.json({ filled: target, value, selector: filledWith, state: fillState });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/select - select option by value/ARIA ref
  app.post("/pages/:name/select", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      const { target, value } = req.body as { target: string; value: string };
      if (!target || !value) { res.status(HTTP.BAD_REQUEST).json({ error: "target and value are required" }); return; }

      let selected = false;
      let selectedWith = "";

      // ARIA ref select (e.g., e1, e5)
      if (/^e\d+$/.test(target)) {
        const elementHandle = await entry.page.evaluateHandle((refId: string): any => {
          const globals = globalThis as any;
          const refs = globals.__devBrowserRefs;
          if (!refs) throw new Error("No snapshot refs found. Run 'aria' first.");
          const element = refs[refId];
          if (!element) throw new Error(`Ref "${refId}" not found. Available: ${Object.keys(refs).join(", ")}`);
          return element;
        }, target);
        const element = elementHandle.asElement();
        if (!element) {
          await elementHandle.dispose();
          res.status(HTTP.NOT_FOUND).json({ error: `Ref '${target}' did not resolve to an element.` });
          return;
        }
        await element.evaluate((node: any, val: string): void => {
          const byValue: any = Array.from(node.options).find((option: any): boolean => option.value === val);
          const byText: any = Array.from(node.options).find((option: any): boolean => option.textContent?.trim() === val);
          const option: any = byValue || byText;
          if (option) { node.value = option.value; node.dispatchEvent(new Event('change', { bubbles: true })); }
          else { throw new Error(`Option "${val}" not found in select`); }
        }, value);
        await elementHandle.dispose();
        res.json({ selected: target, value, selector: "ref" });
        return;
      }

      // Try select-specific CSS selectors first
      if (/^[.#\[]/.test(target)) {
        try { const locator = entry.page.locator(target).first(); if (await locator.count() > 0) { await locator.selectOption(value); selectedWith = target; selected = true; } } catch { void 0; /* selector: try next matching strategy */ }
      }
      if (!selected) {
        for (const sel of [`select[name="${target}"]`, `select#${target}`]) {
          try { const locator = entry.page.locator(sel).first(); if (await locator.count() > 0) { await locator.selectOption(value); selectedWith = sel; selected = true; break; } } catch { void 0; /* selector: try next matching strategy */ }
        }
      }
      if (!selected) {
        const resolved = await resolveField(entry.page, target);
        if (resolved) { await resolved.locator.selectOption(value); selectedWith = resolved.matchedBy; selected = true; }
      }
      if (!selected) { res.status(HTTP.NOT_FOUND).json({ error: `Select element '${target}' not found` }); return; }

      res.json({ selected: target, value, selector: selectedWith });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/text - get text content of element or ARIA ref
  app.post("/pages/:name/text", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      const { target } = req.body as { target: string };
      if (!target) { res.status(HTTP.BAD_REQUEST).json({ error: "target is required" }); return; }

      // ARIA ref text (e.g., e1, e5)
      if (/^e\d+$/.test(target)) {
        const text = await entry.page.evaluate((refId: string): string => {
          const globals = globalThis as any;
          const refs = globals.__devBrowserRefs;
          if (!refs) throw new Error("No snapshot refs found. Run 'aria' first.");
          const element = refs[refId];
          if (!element) throw new Error(`Ref "${refId}" not found. Available: ${Object.keys(refs).join(", ")}`);
          return (element.textContent || "").trim();
        }, target);
        res.json({ text });
        return;
      }

      const locator = entry.page.locator(target).first();
      if (await locator.count() === 0) { res.status(HTTP.NOT_FOUND).json({ error: `Selector '${target}' not found` }); return; }
      const text = await locator.textContent();
      res.json({ text: text?.trim() || "" });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/keys - send keyboard input (type text or press special keys)
  app.post("/pages/:name/keys", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      const { keys } = req.body as { keys: string };
      if (!keys) { res.status(HTTP.BAD_REQUEST).json({ error: "keys is required" }); return; }

      // Special key names that should use press() instead of type()
      const SPECIAL_KEYS = new Set([
        "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Home", "End", "PageUp", "PageDown", "Insert",
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
      ]);
      const isPress = SPECIAL_KEYS.has(keys) || /^(Control|Alt|Meta|Shift)\+/.test(keys);

      let action: string;
      if (isPress) {
        await entry.page.keyboard.press(keys);
        action = "pressed";
      } else {
        await entry.page.keyboard.type(keys);
        action = "typed";
      }

      res.json({ success: true, action, keys });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/jsclick - dispatch JS click events (mousedown/mouseup/click)
  // Use when Playwright's click() doesn't trigger JS event handlers
  app.post("/pages/:name/jsclick", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      const { target } = req.body as { target: string };
      if (!target) { res.status(HTTP.BAD_REQUEST).json({ error: "target is required" }); return; }

      let clickedType = "";
      let elementHandle: import("playwright").ElementHandle | null = null;

      // ARIA ref (e.g., e1, e5)
      if (/^e\d+$/.test(target)) {
        const handle = await entry.page.evaluateHandle((refId: string): any => {
          const globals = globalThis as any;
          const refs = globals.__devBrowserRefs;
          if (!refs) throw new Error("No snapshot refs found. Run 'aria' first.");
          const element = refs[refId];
          if (!element) throw new Error(`Ref "${refId}" not found.`);
          return element;
        }, target);
        elementHandle = handle.asElement();
        if (!elementHandle) { await handle.dispose(); res.status(HTTP.NOT_FOUND).json({ error: `Ref '${target}' not found` }); return; }
        clickedType = "ref";
      }

      // CSS selector
      if (!elementHandle && /^[#.\[]/.test(target)) {
        try {
          const loc = entry.page.locator(target).first();
          if (await loc.count() > 0) { elementHandle = await loc.elementHandle(); clickedType = "selector"; }
        } catch { void 0; /* selector: try next matching strategy */ }
      }

      // Button by text
      if (!elementHandle) {
        try {
          const loc = entry.page.getByRole("button", { name: target });
          if (await loc.count() > 0) { elementHandle = await loc.first().elementHandle(); clickedType = "button"; }
        } catch { void 0; /* selector: try next matching strategy */ }
      }

      // Link by text
      if (!elementHandle) {
        try {
          const loc = entry.page.getByRole("link", { name: target });
          if (await loc.count() > 0) { elementHandle = await loc.first().elementHandle(); clickedType = "link"; }
        } catch { void 0; /* selector: try next matching strategy */ }
      }

      // Text content
      if (!elementHandle) {
        try {
          const loc = entry.page.locator(`text="${target}"`).first();
          if (await loc.count() > 0) { elementHandle = await loc.elementHandle(); clickedType = "text"; }
        } catch { void 0; /* selector: try next matching strategy */ }
      }

      if (!elementHandle) { res.status(HTTP.NOT_FOUND).json({ error: `Element '${target}' not found` }); return; }

      // Dispatch JS click events
      await elementHandle.evaluate((node: any): void => {
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (typeof node.click === 'function') node.click();
      });

      try { await entry.page.waitForLoadState("domcontentloaded", { timeout: TIMEOUTS.SHORT }); } catch { void 0; /* best-effort: proceed if load state times out */ }

      res.json({ jsclicked: target, type: clickedType, url: entry.page.url() });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/wait - wait for selector or text to appear
  app.post("/pages/:name/wait", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      const { target, timeout = TIMEOUTS.LONG } = req.body as { target: string; timeout?: number };
      if (!target) { res.status(HTTP.BAD_REQUEST).json({ error: "target is required" }); return; }

      let found = "";
      const looksLikeSelector = /^[#.\[]/.test(target) || /^[a-z][a-z0-9-]*$/i.test(target);

      if (looksLikeSelector) {
        // Try as CSS selector first
        try {
          await entry.page.locator(target).first().waitFor({ timeout });
          found = `selector: ${target}`;
        } catch { void 0; /* selector: fall through to text matching */ }
      }

      if (!found) {
        // Try as text
        try {
          await entry.page.getByText(target).first().waitFor({ timeout });
          found = `text: ${target}`;
        } catch { void 0; /* selector: target not found within timeout */
          res.status(HTTP.TIMEOUT).json({ error: `'${target}' not found within ${timeout}ms` });
          return;
        }
      }

      res.json({ success: true, found, url: entry.page.url() });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /pages/:name/upload - upload file to a file input element
  app.post("/pages/:name/upload", async (req: Request<{ name: string }>, res: Response): Promise<void> => {
    const pageEntry = getPageEntry(req, res);
    if (!pageEntry) return;
    const { entry } = pageEntry;
    try {
      const { target, filepath } = req.body as { target: string; filepath: string };
      if (!target) { res.status(HTTP.BAD_REQUEST).json({ error: "target is required" }); return; }
      if (!filepath) { res.status(HTTP.BAD_REQUEST).json({ error: "filepath is required" }); return; }

      const fs = await import("fs");
      if (!fs.existsSync(filepath)) { res.status(HTTP.BAD_REQUEST).json({ error: `File not found: ${filepath}` }); return; }

      const isRef = /^e\d+$/.test(target);
      const looksLikeSelector = /^[a-z]+\[|^\[|^#|^\./.test(target);

      // ARIA ref
      if (isRef) {
        const handle = await entry.page.evaluateHandle((refId: string): any => {
          const globals = globalThis as any;
          const refs = globals.__devBrowserRefs;
          if (!refs) throw new Error("No snapshot refs found. Run 'aria' first.");
          const element = refs[refId];
          if (!element) throw new Error(`Ref "${refId}" not found.`);
          return element;
        }, target);
        const element = handle.asElement();
        if (!element) { await handle.dispose(); res.status(HTTP.NOT_FOUND).json({ error: `Ref '${target}' not found or not a file input` }); return; }
        await element.setInputFiles(filepath);
        res.json({ uploaded: filepath, target, type: "ref" });
        return;
      }

      // CSS selector
      if (looksLikeSelector) {
        const locator = entry.page.locator(target).first();
        if (await locator.count() > 0) {
          await locator.setInputFiles(filepath);
          res.json({ uploaded: filepath, target, type: "selector" });
          return;
        }
      }

      // By name or id attribute
      const selectors = [
        `input[type="file"][name="${target}"]`,
        `input[type="file"]#${target}`,
      ];
      // Generic fallback for "file" or "upload" target
      if (/^(file|upload)$/i.test(target)) {
        selectors.push('input[type="file"]');
      }
      for (const sel of selectors) {
        const locator = entry.page.locator(sel).first();
        if (await locator.count() > 0) {
          await locator.setInputFiles(filepath);
          res.json({ uploaded: filepath, target, selector: sel, type: "name" });
          return;
        }
      }

      // Search iframes
      const frames = entry.page.frames();
      for (const frame of frames) {
        if (frame === entry.page.mainFrame()) continue;
        try {
          const sel = looksLikeSelector ? target : `input[type="file"][name="${target}"]`;
          const locator = frame.locator(sel).first();
          if (await locator.count() > 0) {
            await locator.setInputFiles(filepath);
            res.json({ uploaded: filepath, target, selector: sel, type: "iframe" });
            return;
          }
          const generic = frame.locator('input[type="file"]').first();
          if (await generic.count() > 0) {
            await generic.setInputFiles(filepath);
            res.json({ uploaded: filepath, target: 'input[type="file"]', type: "iframe" });
            return;
          }
        } catch { void 0; /* selector: iframe may be detached */ }
      }

      res.status(HTTP.NOT_FOUND).json({ error: `File input '${target}' not found (checked page and iframes)` });
    } catch (err) {
      res.status(HTTP.SERVER_ERROR).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Start the server
  const server = app.listen(port, (): void => {
    console.log(`HTTP API server running on port ${port}`);
  });

  // Track active connections for clean shutdown
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket): void => {
    connections.add(socket);
    socket.on("close", (): void => { connections.delete(socket); });
  });

  // Track if cleanup has been called to avoid double cleanup
  let cleaningUp = false;

  // Cleanup function
  const cleanup = async (): Promise<void> => {
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
      } catch { void 0; /* cleanup: page might already be closed */ }
    }
    registry.clear();

    // Close context (this also closes the browser) - but NOT in user mode
    if (browserMode !== "user") {
      try {
        await context.close();
      } catch { void 0; /* cleanup: context might already be closed */ }
    } else {
      // In user mode, just disconnect our CDP client (NEVER close the user's browser)
      if (userConn) {
        try {
          userConn.close();
        } catch { void 0; /* cleanup: CDP connection might already be closed */ }
      }
    }

    server.close();
    console.log("Server stopped.");
  };

  // Synchronous cleanup for forced exits
  const syncCleanup = (): void => {
    try {
      context.close();
    } catch { void 0; /* cleanup: best effort on forced exit */ }
  };

  // Signal handlers (consolidated to reduce duplication)
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  const signalHandler = async (): Promise<void> => {
    await cleanup();
    process.exit(0);
  };

  // Error handler - log but DON'T exit for recoverable errors
  const errorHandler = (err: unknown, type: string): void => {
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

    const isFatal = fatalPatterns.some((pattern: string): boolean => errStr.includes(pattern));
    if (isFatal) {
      console.error(`[${timestamp}] FATAL ERROR - server will exit`);
      cleanup().finally((): never => process.exit(1));
    } else {
      console.error(`[${timestamp}] Recoverable error - server continues`);
    }
  };

  // Wrapped error handlers for removal
  const uncaughtHandler = (err: unknown): void => { errorHandler(err, "uncaughtException"); };
  const rejectionHandler = (err: unknown): void => { errorHandler(err, "unhandledRejection"); };

  // Register handlers (once each)
  signals.forEach((signal: typeof signals[number]): void => { process.on(signal, signalHandler); });
  process.on("uncaughtException", uncaughtHandler);
  process.on("unhandledRejection", rejectionHandler);
  process.on("exit", syncCleanup);

  // Helper to remove all handlers
  const removeHandlers = (): void => {
    signals.forEach((signal: typeof signals[number]): void => { process.off(signal, signalHandler); });
    process.off("uncaughtException", uncaughtHandler);
    process.off("unhandledRejection", rejectionHandler);
    process.off("exit", syncCleanup);
  };

  return {
    wsEndpoint,
    port,
    async stop(): Promise<void> {
      removeHandlers();
      await cleanup();
    },
  };
}
