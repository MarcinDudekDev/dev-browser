import express, { type Express, type Request, type Response } from "express";
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";
import type { Socket } from "net";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
  GetLLMTreeResponse,
  GetSelectorResponse,
} from "./types";
import { getLLMTreeWithBackendIds, resolveSelectorFromBackendId } from "./dom/index.js";

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

  console.log("Launching browser with persistent context...");

  // Launch persistent context - this persists cookies, localStorage, cache, etc.
  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: [`--remote-debugging-port=${cdpPort}`],
  });
  console.log("Browser launched with persistent profile...");

  // Get the CDP WebSocket endpoint from Chrome's JSON API (with retry for slow startup)
  const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

  // Registry entry type with selector map for persistent element identification
  interface PageEntry {
    page: Page;
    targetId: string;
    /** Map of element index to CSS selector (always available for indexed elements) */
    cssSelectorMap: Map<number, string> | null;
    /** Map of element index to CDP backendNodeId (may have fewer entries if CDP resolution failed) */
    backendNodeMap: Map<number, number> | null;
    /** Version counter, incremented on each tree extraction or navigation */
    mapVersion: number;
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
      entry = { page, targetId, cssSelectorMap: null, backendNodeMap: null, mapVersion: 0 };
      registry.set(name, entry);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", () => {
        registry.delete(name);
      });

      // Invalidate selector maps on navigation (URL change)
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          const currentEntry = registry.get(name);
          if (currentEntry) {
            currentEntry.cssSelectorMap = null;
            currentEntry.backendNodeMap = null;
            currentEntry.mapVersion++;
          }
        }
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

  // POST /pages/:name/tree - get LLM tree and update selector map
  app.post("/pages/:name/tree", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (!entry) {
      res.status(404).json({ error: "page not found" });
      return;
    }

    try {
      // Extract LLM tree with backend node IDs
      const { tree, selectorMap, backendNodeMap } = await getLLMTreeWithBackendIds(
        entry.page,
        context
      );

      // Update entry with both maps
      entry.cssSelectorMap = selectorMap;
      entry.backendNodeMap = backendNodeMap;
      entry.mapVersion++;

      const response: GetLLMTreeResponse = {
        tree,
        version: entry.mapVersion,
        elementCount: selectorMap.size,
      };
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `Failed to extract tree: ${message}` });
    }
  });

  // GET /pages/:name/selector/:index - get CSS selector for element by index
  app.get(
    "/pages/:name/selector/:index",
    async (req: Request<{ name: string; index: string }>, res: Response) => {
      const name = decodeURIComponent(req.params.name);
      const index = parseInt(req.params.index, 10);

      if (isNaN(index)) {
        res.status(400).json({ error: "index must be a number" });
        return;
      }

      const entry = registry.get(name);

      if (!entry) {
        res.status(404).json({ error: "page not found" });
        return;
      }

      if (!entry.cssSelectorMap) {
        res.status(400).json({
          error: "No active tree. Call POST /pages/:name/tree first.",
        });
        return;
      }

      // Check if the index exists in the CSS selector map (canonical source)
      const cssSelector = entry.cssSelectorMap.get(index);
      if (cssSelector === undefined) {
        res.status(404).json({
          error: `Element with index ${index} not found in current tree`,
        });
        return;
      }

      // Try to use backendNodeId for more reliable resolution
      const backendNodeId = entry.backendNodeMap?.get(index);

      if (backendNodeId !== undefined) {
        try {
          // Resolve backendNodeId to CSS selector (preferred - more reliable)
          const selector = await resolveSelectorFromBackendId(entry.page, context, backendNodeId);

          const response: GetSelectorResponse = {
            index,
            selector,
            backendNodeId,
          };
          res.json(response);
          return;
        } catch {
          // Backend node resolution failed, fall back to CSS selector
        }
      }

      // Fall back to the original CSS selector from tree extraction
      const response: GetSelectorResponse = {
        index,
        selector: cssSelector,
        backendNodeId: backendNodeId ?? 0,
      };
      res.json(response);
    }
  );

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

  const errorHandler = async (err: unknown) => {
    console.error("Unhandled error:", err);
    await cleanup();
    process.exit(1);
  };

  // Register handlers
  signals.forEach((sig) => process.on(sig, signalHandler));
  process.on("uncaughtException", errorHandler);
  process.on("unhandledRejection", errorHandler);
  process.on("exit", syncCleanup);

  // Helper to remove all handlers
  const removeHandlers = () => {
    signals.forEach((sig) => process.off(sig, signalHandler));
    process.off("uncaughtException", errorHandler);
    process.off("unhandledRejection", errorHandler);
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
