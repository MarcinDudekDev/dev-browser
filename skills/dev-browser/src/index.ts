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

export async function serve(options: ServeOptions = {}): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const headless = options.headless ?? false;
  const cdpPort = options.cdpPort ?? 9223;
  const profileDir = options.profileDir;

  // Validate port numbers
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}. Must be between 1 and 65535`);
  }
  if (cdpPort < 1 || cdpPort > 65535) {
    throw new Error(`Invalid cdpPort: ${cdpPort}. Must be between 1 and 65535`);
  }
  if (port === cdpPort) {
    throw new Error("port and cdpPort must be different");
  }

  // Determine user data directory for persistent context
  const userDataDir = profileDir
    ? join(profileDir, "browser-data")
    : join(process.cwd(), ".browser-data");

  // Create directory if it doesn't exist
  mkdirSync(userDataDir, { recursive: true });
  console.log(`Using persistent browser profile: ${userDataDir}`);

  // Fix Chrome preferences BEFORE launch to prevent crash dialog
  fixChromePreferences(userDataDir);

  console.log("Launching browser with persistent context...");

  // Launch persistent context - this persists cookies, localStorage, cache, etc.
  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: [
      `--remote-debugging-port=${cdpPort}`,
      // Auto-restore sessions after crash (no dialog)
      "--restore-last-session",
      // Disable crash recovery bubble (auto-restore instead)
      "--disable-session-crashed-bubble",
    ],
  });
  console.log("Browser launched with persistent profile...");

  // Get the CDP WebSocket endpoint from Chrome's JSON API (with retry for slow startup)
  const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

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
    res.json(response);
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

    // Check if page already exists
    let entry = registry.get(name);
    if (!entry) {
      // Create new page in the persistent context (with timeout to prevent hangs)
      const page = await withTimeout(context.newPage(), 30000, "Page creation timed out after 30s");
      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(name, entry);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", () => {
        registry.delete(name);
      });
    }

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

    // Close context (this also closes the browser)
    try {
      await context.close();
    } catch {
      // Context might already be closed
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
