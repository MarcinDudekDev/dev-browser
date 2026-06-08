import { describe, test, expect, beforeAll, afterAll } from "../test-shim";
import { serve, type DevBrowserServer } from "../index";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const SCRIPT_TIMEOUT = 15000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FP_PORT = 19224;
const FP_CDP_PORT = 19225;
const BASE = `http://localhost:${FP_PORT}`;
const SCRIPTS_DIR = join(__dirname, "..", "..", "scripts");
const TEST_PAGE_URL = pathToFileURL(join(__dirname, "test-page.html")).href;
const PREFIX = "test";
const PAGE = "fp";
const PAGE_ID = `${PREFIX}-${PAGE}`;

let server: DevBrowserServer;
let profileDir: string;

// Run a shell script with the correct env vars (async to avoid deadlock)
async function runScript(
  name: string,
  args: string,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = {
    ...process.env,
    SCRIPT_ARGS: args,
    PROJECT_PREFIX: PREFIX,
    PAGE_NAME: PAGE,
    SERVER_PORT: String(FP_PORT),
    ...extraEnv,
  };
  try {
    const { stdout, stderr } = await execAsync(`bash "${SCRIPTS_DIR}/${name}"`, {
      env,
      timeout: SCRIPT_TIMEOUT,
    });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: String(err.stdout || ""),
      stderr: String(err.stderr || ""),
      exitCode: err.code ?? 1,
    };
  }
}

// Find ARIA ref on a line containing the given text
function findRef(snapshot: string, nearText: string): string | undefined {
  for (const line of snapshot.split("\n")) {
    if (line.includes(nearText)) {
      const refMatch = line.match(/\[ref=(e\d+)\]/);
      if (refMatch) return refMatch[1];
    }
  }
  return undefined;
}

beforeAll(async (): Promise<void> => {
  profileDir = mkdtempSync(join(tmpdir(), "dev-browser-fp-test-"));
  server = await serve({ port: FP_PORT, headless: true, cdpPort: FP_CDP_PORT, profileDir });

  // Create page and navigate via API (isolates setup from shell script tests)
  await fetch(`${BASE}/pages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: PAGE_ID }),
  });
  await fetch(`${BASE}/pages/${PAGE_ID}/goto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: TEST_PAGE_URL }),
  });
}, 60000);

afterAll(async (): Promise<void> => {
  if (server) await server.stop();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { void 0; /* cleanup: ignore server shutdown errors */ }
}, 30000);

describe("Fast-Path Shell Scripts", (): void => {
  test("goto.sh returns URL and Title", async (): Promise<void> => {
    const result = await runScript("goto.sh", TEST_PAGE_URL);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("URL:");
    expect(result.stdout).toContain("Title:");
    expect(result.stdout).toContain("Dev Browser Test Page");
  });

  test("click.sh with text target succeeds", async (): Promise<void> => {
    const result = await runScript("click.sh", "Click Me");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Clicked");
    expect(result.stdout).toContain("Click Me");
  });

  test("aria.sh returns snapshot with refs", async (): Promise<void> => {
    const result = await runScript("aria.sh", "");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("heading");
    expect(result.stdout).toContain("Test Page");
    expect(result.stdout).toMatch(/\[ref=e\d+\]/);
  });

  test("click.sh with ARIA ref succeeds", async (): Promise<void> => {
    // Get ARIA snapshot to find a ref
    const ariaResult = await runScript("aria.sh", "");
    const ref = findRef(ariaResult.stdout, "Click Me");
    expect(ref).toBeTruthy();

    const result = await runScript("click.sh", ref!);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Clicked");
  });

  test("fill.sh single field succeeds", async (): Promise<void> => {
    const result = await runScript("fill.sh", "username testvalue", {
      SCRIPT_ARGC: "2",
      SCRIPT_ARG0: "username",
      SCRIPT_ARG1: "testvalue",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Filled: username");
  });

  test("fill.sh JSON mode succeeds", async (): Promise<void> => {
    const json = JSON.stringify({ email: "test@test.com" });
    const result = await runScript("fill.sh", json);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Filled:");
    expect(result.stdout).toContain("email");
  });

  test("text.sh with CSS selector returns text", async (): Promise<void> => {
    const result = await runScript("text.sh", "#intro");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test page for dev-browser");
  });

  test("text.sh with ARIA ref returns text", async (): Promise<void> => {
    const ariaResult = await runScript("aria.sh", "");
    const ref = findRef(ariaResult.stdout, "Submit Form");
    expect(ref).toBeTruthy();

    const result = await runScript("text.sh", ref!);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Submit Form");
  });

  test("keys.sh types text", async (): Promise<void> => {
    // Focus username field first
    await runScript("click.sh", "#username");
    const result = await runScript("keys.sh", "testkeys");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Keys typed: testkeys");
  });

  test("keys.sh presses special key", async (): Promise<void> => {
    const result = await runScript("keys.sh", "Enter");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Keys pressed: Enter");
  });

  test("select.sh succeeds", async (): Promise<void> => {
    const result = await runScript("select.sh", "country us");
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.selected).toBe("country");
    expect(json.value).toBe("us");
  });

  test("jsclick.sh with text target succeeds", async (): Promise<void> => {
    const result = await runScript("jsclick.sh", "Click Me");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("JS-Clicked");
    expect(result.stdout).toContain("Click Me");
  });

  test("jsclick.sh with CSS selector succeeds", async (): Promise<void> => {
    const result = await runScript("jsclick.sh", "#counter-btn");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("JS-Clicked");
  });

  test("wait.sh with CSS selector succeeds", async (): Promise<void> => {
    const result = await runScript("wait.sh", "#action-btn");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Found");
    expect(result.stdout).toContain("#action-btn");
  });

  test("wait.sh with text succeeds", async (): Promise<void> => {
    const result = await runScript("wait.sh", "test page for dev-browser");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Found");
  });
});
