// "Clicked" must mean the element received the click — never a reply we could not read.
//
// asrowerowy-system #181 (2026-09-28): `click "#ean-cancel"` and `click "Anuluj"` printed
// "Clicked : Anuluj" with a blank URL/Title and exit 0 while the page's capture listener
// saw nothing. Root cause: click.sh gave curl 10s, the server's role→frame→iframe→selector
// chain took longer, and an EMPTY reply had no `.error`, so it was printed as success.
import { describe, test, expect, beforeAll, afterAll } from "../test-shim";
import { serve, type DevBrowserServer } from "../index";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { createServer, type Server } from "net";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 19234;
const CDP_PORT = 19235;
const BASE = `http://localhost:${PORT}`;
const ROOT = join(__dirname, "..", "..");
const SCRIPTS_DIR = join(ROOT, "builtins");
const PAGE_URL = pathToFileURL(join(__dirname, "unhidden-button.html")).href;
const PREFIX = "test";
const PAGE = "truth";
const PAGE_ID = `${PREFIX}-${PAGE}`;

let server: DevBrowserServer;
let profileDir: string;

async function run(cmd: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number; ms: number }> {
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execAsync(cmd, { env: { ...process.env, ...env }, timeout: 60000 });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0, ms: Date.now() - t0 };
  } catch (err: any) {
    return { stdout: String(err.stdout || ""), stderr: String(err.stderr || ""), exitCode: err.code ?? 1, ms: Date.now() - t0 };
  }
}

function click(target: string, port = PORT) {
  return run(`bash "${SCRIPTS_DIR}/click.sh"`, {
    SCRIPT_ARGS: target, PROJECT_PREFIX: PREFIX, PAGE_NAME: PAGE, SERVER_PORT: String(port),
  });
}

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

// Fresh page per test, button already unhidden, empty listener log.
async function freshPage(): Promise<void> {
  await post(`/pages/${PAGE_ID}/goto`, { url: PAGE_URL });
  for (let i = 0; i < 20; i++) {
    const r = await post(`/pages/${PAGE_ID}/evaluate`, { code: "!document.getElementById('x').hidden" });
    if (r.result === true) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("fixture button never became visible");
}

async function listenerLog(): Promise<string[]> {
  const r = await post(`/pages/${PAGE_ID}/evaluate`, { code: "window.__log" });
  return r.result;
}

beforeAll(async (): Promise<void> => {
  profileDir = mkdtempSync(join(tmpdir(), "dev-browser-truth-test-"));
  server = await serve({ port: PORT, headless: true, cdpPort: CDP_PORT, profileDir });
  await post("/pages", { name: PAGE_ID });
}, 60000);

afterAll(async (): Promise<void> => {
  if (server) await server.stop();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { void 0; /* cleanup */ }
}, 30000);

describe("click reports only clicks that happened", (): void => {
  test("CSS selector on a just-unhidden button: clicked before the CLI returns, and fast", async (): Promise<void> => {
    await freshPage();
    const r = await click("#x");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Clicked selector: #x");
    // Read immediately: the click must have landed BEFORE "Clicked" was printed.
    expect(await listenerLog()).toEqual(["x"]);
    // It used to walk ~10s of role/frame timeouts first, outliving the CLI's reply window.
    expect(r.ms < 5000).toBeTruthy();
  });

  test("exact accessible name wins over a longer name that contains it", async (): Promise<void> => {
    await freshPage();
    const r = await click("Anuluj");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Clicked button: Anuluj");
    expect(await listenerLog()).toEqual(["x"]);
  });

  test("a label that merely starts like a selector is still clicked by name", async (): Promise<void> => {
    await freshPage();
    const r = await click("#2 zlecenie"); // invalid CSS, valid accessible name
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Clicked button: #2 zlecenie");
    expect(await listenerLog()).toEqual(["hash"]);
  });

  test("unclickable selector fails loudly, never prints Clicked", async (): Promise<void> => {
    await freshPage();
    const r = await click("#nonexistent");
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("Clicked");
    expect(r.stderr).toContain("click failed");
    expect(await listenerLog()).toEqual([]);
  });

  test("no server reply (connection refused) is a failure, not an empty success", async (): Promise<void> => {
    const r = await click("#x", 1); // nothing listens on port 1
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("Clicked");
  });

  test("fp_post: a server that accepts but never answers times out as UNKNOWN, exit 1", async (): Promise<void> => {
    // The exact shape of the original bug: curl gives up, body is empty.
    const hang: Server = createServer(() => { /* accept, never reply */ });
    await new Promise<void>((res) => hang.listen(0, "127.0.0.1", () => res()));
    const port = (hang.address() as any).port;
    try {
      const r = await run(`bash -c 'source "${ROOT}/lib/fastpath.sh"; fp_post /pages/x/click "{}" 1 && echo REACHED-SUCCESS'`, { SERVER_PORT: String(port) });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("REACHED-SUCCESS");
      expect(r.stderr).toContain("UNKNOWN");
    } finally {
      hang.close();
    }
  });
});
