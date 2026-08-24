import { serve } from "@/index.js";
import { execSync } from "child_process";
import { mkdirSync, existsSync, readdirSync, appendFileSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const devBrowserHome = process.env.DEV_BROWSER_HOME || join(process.env.HOME || "/tmp", ".dev-browser");
const tmpDir = join(devBrowserHome, "tmp");
const browserModeForProfile = process.env.BROWSER_MODE || "dev";
const profileDir = join(devBrowserHome, "profiles", browserModeForProfile);
const crashLogFile = join(tmpDir, `crash-${browserModeForProfile}.log`);
const sessionFile = join(tmpDir, `sessions-${browserModeForProfile}.json`);

// Crash logging helper
function logCrash(message: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  try {
    appendFileSync(crashLogFile, entry);
  } catch {
    // Best effort
  }
  console.error(entry.trim());
}

// Track active sessions for loss notification
interface SessionInfo {
  pages: string[];
  startedAt: string;
  crashedAt?: string;
  lostPages?: string[];
}

function saveSessionInfo(info: SessionInfo) {
  try {
    writeFileSync(sessionFile, JSON.stringify(info, null, 2));
  } catch {
    // Best effort
  }
}

function loadSessionInfo(): SessionInfo | null {
  try {
    if (existsSync(sessionFile)) {
      return JSON.parse(readFileSync(sessionFile, "utf-8"));
    }
  } catch {
    // Ignore
  }
  return null;
}

// Create tmp and profile directories if they don't exist
console.log("Creating tmp directory...");
mkdirSync(tmpDir, { recursive: true });
console.log("Creating profiles directory...");
mkdirSync(profileDir, { recursive: true });

// Install Playwright browsers if not already installed
console.log("Checking Playwright browser installation...");

function findPackageManager(): { name: string; command: string } | null {
  // npm first: CLAUDE.md makes Node/npm the standard for this repo, and
  // package-lock.json is the tracked lockfile. Bun was first here, so on any
  // machine that happens to have bun installed the browser install silently
  // went through bunx instead — the opposite of the documented standard.
  const managers = [
    { name: "npm", command: "npx playwright install chromium" },
    { name: "pnpm", command: "pnpm exec playwright install chromium" },
    { name: "bun", command: "bunx playwright install chromium" },
  ];

  for (const manager of managers) {
    try {
      execSync(`which ${manager.name}`, { stdio: "ignore" });
      return manager;
    } catch {
      // Package manager not found, try next
    }
  }
  return null;
}

function getPlaywrightCacheDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  // Playwright uses ~/Library/Caches/ms-playwright on macOS, ~/.cache/ms-playwright on Linux/Windows
  if (process.platform === "darwin") {
    return join(homeDir, "Library", "Caches", "ms-playwright");
  }
  return join(homeDir, ".cache", "ms-playwright");
}

function isChromiumInstalled(): boolean {
  const playwrightCacheDir = getPlaywrightCacheDir();

  if (!existsSync(playwrightCacheDir)) return false;

  try {
    const entries = readdirSync(playwrightCacheDir);
    return entries.some((entry) => entry.startsWith("chromium"));
  } catch {
    return false;
  }
}

try {
  if (!isChromiumInstalled()) {
    console.log("Playwright Chromium not found. Installing (this may take a minute)...");

    const pm = findPackageManager();
    if (!pm) {
      throw new Error("No package manager found (tried bun, pnpm, npm)");
    }

    console.log(`Using ${pm.name} to install Playwright...`);
    execSync(pm.command, { stdio: "inherit" });
    console.log("Chromium installed successfully.");
  } else {
    console.log("Playwright Chromium already installed.");
  }
} catch (error) {
  console.error("Failed to install Playwright browsers:", error);
  console.log("You may need to run: npx playwright install chromium");
}

// Get port config early for startup checks
const startupHttpPort = parseInt(process.env.HTTP_PORT || "9220", 10);
const startupCdpPort = parseInt(process.env.CDP_PORT || "9221", 10);

// Check if server is already running on this mode's port
console.log(`Checking for existing server on port ${startupHttpPort}...`);
try {
  const res = await fetch(`http://localhost:${startupHttpPort}`, {
    signal: AbortSignal.timeout(1000),
  });
  if (res.ok) {
    console.log(`Server already running on port ${startupHttpPort}`);
    process.exit(0);
  }
} catch {
  // Server not running, continue to start
}

// Clean up stale CDP port if HTTP server isn't running (crash recovery).
// NEVER do this in user mode: CDP_PORT there is the user's REAL browser port
// (9222), and killing it would close all their tabs. Only own dev/stealth
// Chromium instances are ours to reclaim.
if ((process.env.BROWSER_MODE || "dev") !== "user") {
  // Use netstat (fast) instead of lsof (hangs on macOS)
  try {
    const listening = execSync(
      `netstat -anp tcp 2>/dev/null | grep '\\.${startupCdpPort} ' | grep LISTEN`,
      { encoding: "utf-8", timeout: 3000 }
    ).trim();
    if (listening) {
      console.log(`Stale process detected on CDP port ${startupCdpPort}, attempting cleanup...`);
      // Try to kill via fuser (available on most systems) as lsof hangs on macOS
      try {
        execSync(`kill -9 $(fuser ${startupCdpPort}/tcp 2>/dev/null) 2>/dev/null`, { timeout: 3000 });
      } catch { /* best effort */ }
    }
  } catch {
    // No process on CDP port — expected
  }
}

// Check for previous crash and notify
const previousSession = loadSessionInfo();
if (previousSession?.crashedAt) {
  console.log("\n=== PREVIOUS SESSION CRASHED ===");
  console.log(`Crashed at: ${previousSession.crashedAt}`);
  if (previousSession.lostPages && previousSession.lostPages.length > 0) {
    console.log(`Lost pages (will need to re-navigate):`);
    previousSession.lostPages.forEach((p) => console.log(`  - ${p}`));
  }
  console.log("================================\n");
  // Clear crash info after showing
  saveSessionInfo({ pages: [], startedAt: new Date().toISOString() });
}

console.log("Starting dev browser server...");
const headless = process.env.HEADLESS === "true";
const browserMode = (process.env.BROWSER_MODE || "dev") as "dev" | "stealth" | "user";
const httpPort = parseInt(process.env.HTTP_PORT || "9220", 10);
const cdpPort = parseInt(process.env.CDP_PORT || "9221", 10);
console.log(`Browser mode: ${browserMode} (HTTP: ${httpPort}, CDP: ${cdpPort})`);
let server: Awaited<ReturnType<typeof serve>>;

try {
  server = await serve({
    port: httpPort,
    cdpPort,
    headless,
    profileDir,
    browserMode,
  });
} catch (err) {
  logCrash(`Server failed to start: ${err}`);
  throw err;
}

console.log(`Dev browser server started`);
console.log(`  WebSocket: ${server.wsEndpoint}`);
console.log(`  Tmp directory: ${tmpDir}`);
console.log(`  Profile directory: ${profileDir}`);
console.log(`  Crash log: ${crashLogFile}`);
console.log(`\nReady`);
console.log(`\nPress Ctrl+C to stop`);

// Save initial session info
saveSessionInfo({ pages: [], startedAt: new Date().toISOString() });

// Periodic page tracking (for crash recovery info)
const pageTracker = setInterval(async () => {
  try {
    const res = await fetch(`http://localhost:${httpPort}/pages`);
    if (res.ok) {
      const data = await res.json() as { pages: string[] };
      saveSessionInfo({
        pages: data.pages,
        startedAt: new Date().toISOString(),
      });
    }
  } catch {
    // Server might be shutting down
  }
}, 30000); // Every 30 seconds

// Handle crash - save lost pages info
const handleCrash = (reason: string) => {
  logCrash(reason);
  const session = loadSessionInfo();
  if (session) {
    session.crashedAt = new Date().toISOString();
    session.lostPages = session.pages;
    saveSessionInfo(session);
  }
  clearInterval(pageTracker);
};

process.on("uncaughtException", (err) => {
  handleCrash(`Uncaught exception: ${err.message}`);
});

process.on("unhandledRejection", (err) => {
  handleCrash(`Unhandled rejection: ${err}`);
});

// Keep the process running
await new Promise(() => {});
