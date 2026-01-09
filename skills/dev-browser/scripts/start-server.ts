import { serve } from "@/index.js";
import { execSync } from "child_process";
import { mkdirSync, existsSync, readdirSync, appendFileSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(__dirname, "..", "tmp");
const profileDir = join(__dirname, "..", "profiles");
const crashLogFile = join(tmpDir, "crash.log");
const sessionFile = join(tmpDir, "sessions.json");

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
  const managers = [
    { name: "bun", command: "bunx playwright install chromium" },
    { name: "pnpm", command: "pnpm exec playwright install chromium" },
    { name: "npm", command: "npx playwright install chromium" },
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

function isChromiumInstalled(): boolean {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const playwrightCacheDir = join(homeDir, ".cache", "ms-playwright");

  if (!existsSync(playwrightCacheDir)) {
    return false;
  }

  // Check for chromium directories (e.g., chromium-1148, chromium_headless_shell-1148)
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

// Check if server is already running
console.log("Checking for existing servers...");
try {
  const res = await fetch("http://localhost:9222", {
    signal: AbortSignal.timeout(1000),
  });
  if (res.ok) {
    process.exit(0);
  }
} catch {
  // Server not running, continue to start
}

// Clean up stale CDP port if HTTP server isn't running (crash recovery)
// This handles the case where Node crashed but Chrome is still running on 9223
try {
  const pid = execSync("lsof -ti:9223", { encoding: "utf-8" }).trim();
  if (pid) {
    console.log(`Cleaning up stale Chrome process on CDP port 9223 (PID: ${pid})`);
    execSync(`kill -9 ${pid}`);
  }
} catch {
  // No process on CDP port, which is expected
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
let server: Awaited<ReturnType<typeof serve>>;

try {
  server = await serve({
    port: 9222,
    headless,
    profileDir,
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

// Log restored sessions after crash recovery
async function logRestoredSessions() {
  try {
    // Wait for Chrome to restore sessions
    await new Promise(r => setTimeout(r, 3000));

    const res = await fetch("http://localhost:9222/pages");
    if (!res.ok) return;

    const data = await res.json() as { pages: string[] };
    if (data.pages.length > 0) {
      console.log(`Sessions restored: ${data.pages.length} pages active`);
      data.pages.forEach(p => console.log(`  - ${p}`));

      // Update session tracking
      saveSessionInfo({
        pages: data.pages,
        startedAt: new Date().toISOString(),
      });
    }
  } catch {
    // Non-fatal
  }
}

// Check for restored sessions in background
logRestoredSessions();

// Periodic page tracking (for crash recovery info)
const pageTracker = setInterval(async () => {
  try {
    const res = await fetch("http://localhost:9222/pages");
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
