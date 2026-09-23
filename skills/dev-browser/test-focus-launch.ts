// Live GUI check: does dev-browser steal macOS focus when its browser starts?
//
// Starts a throwaway server through server.sh (the exact production launch path:
// server.sh -> start-server.ts -> serve() -> launchBrowserContext) on spare ports
// with a scratch DEV_BROWSER_HOME, and drives page create + goto + screenshot
// through the client while sampling the frontmost app every ~40ms.
// Three rounds on ONE profile:
//   fresh    - first launch on an empty profile
//   crash    - Chromium SIGKILLed under a live server; the next page request
//              makes ensureContext() relaunch it
//   restart  - server and Chromium both SIGKILLed, server started again on the
//              same profile, so --restore-last-session has tabs to bring back
// FAILS if the automation browser became frontmost with no human mouse click in
// the second before; a raise right after a click is reported but not counted.
//
// The frontmost app is read with `lsappinfo`, which needs no TCC grant, unlike
// osascript + System Events, which answers -1743 from this launch context.
// The shared dev (9220) and stealth (9224) servers are never touched.
//
// Run: ./node_modules/.bin/tsx test-focus-launch.ts
import { spawn, execFile, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { connect } from "./src/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 9340;
const CDP_PORT = 9341;
const AUTOMATION_APP_RE = /Chrome for Testing|Chromium/i;
const SAMPLE_MS = 40;
const LATE_RAISE_MS = 1500;
// Chromium writes its session file a few seconds after tabs change; without a
// pause the restart round has nothing to restore and cannot catch a restore raise.
const SESSION_SAVE_MS = 12_000;
// Restored windows show up some time after launch, not during it.
const RESTORE_WATCH_MS = 45_000;
const HEALTH_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r): void => { setTimeout(r, ms); });

function frontmost(): Promise<string> {
  return new Promise((resolve): void => {
    execFile("lsappinfo", ["front"], (e1, asn): void => {
      if (e1) { resolve("?"); return; }
      execFile("lsappinfo", ["info", "-only", "name", asn.trim()], (e2, out): void => {
        const m = /"LSDisplayName"="([^"]*)"/.exec(out ?? "");
        resolve(e2 || !m ? "?" : m[1]);
      });
    });
  });
}

// Seconds since the last human MOUSE click. Clicking a visible automation window
// makes it frontmost too, and that is not a steal. Typing never raises another
// app, so key events must not excuse a raise: the pre-fix launch stole focus
// while the human was typing (HIDIdleTime 0.2s) and an any-input timer called
// that "human". JXA reads CGEventSource without any TCC grant.
function humanIdleSeconds(): Promise<number> {
  return new Promise((resolve): void => {
    execFile("osascript", ["-l", "JavaScript", "-e",
      "ObjC.import('CoreGraphics'); Math.min($.CGEventSourceSecondsSinceLastEventType(1, 1), $.CGEventSourceSecondsSinceLastEventType(1, 3))"],
    (e, out): void => { const v = Number(String(out).trim()); resolve(e || !Number.isFinite(v) ? 0 : v); });
  });
}
const HUMAN_QUIET_S = 1.0;

class Harness {
  phase = "start";
  readonly seen = new Map<string, number>();
  readonly stolenIn = new Set<string>();
  readonly humanRaised = new Set<string>();
  private prev = "";
  private sampling = true;
  private sampler: Promise<void>;
  private servers: ChildProcess[] = [];
  log = "";

  constructor(readonly home: string) {
    this.sampler = this.sample();
  }

  private async sample(): Promise<void> {
    while (this.sampling) {
      const app = await frontmost();
      this.seen.set(app, (this.seen.get(app) ?? 0) + 1);
      // Judge each RAISE once, at the transition: was a human just active?
      if (AUTOMATION_APP_RE.test(app) && !AUTOMATION_APP_RE.test(this.prev)) {
        const idle = await humanIdleSeconds();
        (idle >= HUMAN_QUIET_S ? this.stolenIn : this.humanRaised).add(`${this.phase} (last click ${idle.toFixed(1)}s ago)`);
      }
      this.prev = app;
      await sleep(SAMPLE_MS);
    }
  }

  async startServer(): Promise<void> {
    const server = spawn("./server.sh", [], {
      cwd: here,
      env: { ...process.env, BROWSER_MODE: "dev", HTTP_PORT: String(HTTP_PORT), CDP_PORT: String(CDP_PORT), DEV_BROWSER_HOME: this.home },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.servers.push(server);
    server.stdout!.on("data", (d): void => { this.log += d; });
    server.stderr!.on("data", (d): void => { this.log += d; });
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const healthy = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`).then((r) => r.ok, () => false);
      if (healthy) return;
      await sleep(200);
    }
    throw new Error(`server never became healthy\n${this.log}`);
  }

  // Our Chromium is the only process whose argv carries this scratch profile.
  async killBrowser(): Promise<void> {
    await new Promise<void>((r): void => { execFile("pkill", ["-9", "-f", `${this.home}/profiles`], (): void => r()); });
    await sleep(1000);
  }

  killServers(): void {
    for (const server of this.servers.splice(0)) {
      try { process.kill(-server.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
  }

  async drive(round: string, pageName: string, url: string): Promise<void> {
    const client = await connect(`http://127.0.0.1:${HTTP_PORT}`);
    this.phase = `${round}:page-create`;
    const page = await client.page(pageName);
    this.phase = `${round}:goto+screenshot`;
    await page.goto(url);
    const shot = join(this.home, `${pageName}.png`);
    await page.screenshot({ path: shot });
    if (!existsSync(shot) || statSync(shot).size < 1000) throw new Error(`${round}: screenshot missing or empty`);
    await client.disconnect();
    this.phase = `${round}:settle`;
    await sleep(LATE_RAISE_MS);
  }

  async stop(): Promise<void> {
    this.sampling = false;
    await this.sampler;
    this.killServers();
    await this.killBrowser();
  }
}

async function main(): Promise<number> {
  const before = await frontmost();
  if (AUTOMATION_APP_RE.test(before)) {
    console.error(`precondition: frontmost is already "${before}" - focus another app first`);
    return 2;
  }
  const home = mkdtempSync(join(process.env.DEV_BROWSER_TEST_TMP || tmpdir(), "dbfocus-"));
  const h = new Harness(home);
  try {
    h.phase = "fresh:launch";
    await h.startServer();
    await h.drive("fresh", "focus-a", "https://example.com/");

    h.phase = "crash:kill";
    await h.killBrowser();
    await h.drive("crash", "focus-b", "https://example.org/");

    h.phase = "restart:session-save";
    await sleep(SESSION_SAVE_MS);
    h.phase = "restart:launch";
    h.killServers();
    await h.killBrowser();
    await h.startServer();
    await h.drive("restart", "focus-c", "https://example.net/");
    h.phase = "restart:restore-watch";
    await sleep(RESTORE_WATCH_MS);
  } catch (err) {
    console.error(`${h.phase}: ${String(err)}\n--- server log (tail) ---\n${h.log.split("\n").slice(-40).join("\n")}`);
    throw err;
  } finally {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  }

  console.log(`frontmost before: ${before}`);
  console.log(`frontmost samples: ${JSON.stringify(Object.fromEntries(h.seen))}`);
  if (h.humanRaised.size) console.log(`ignored, human click just before: ${[...h.humanRaised].join(", ")}`);
  if (h.stolenIn.size) {
    console.log(`FAIL: automation browser took focus during: ${[...h.stolenIn].join(", ")}`);
    return 1;
  }
  console.log("PASS: automation browser never became frontmost (fresh, crash-relaunch, restart+restore)");
  return 0;
}

main().then((c): never => process.exit(c), (e): never => { console.error(e); process.exit(1); });
