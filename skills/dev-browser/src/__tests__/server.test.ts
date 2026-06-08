import { describe, test, expect, beforeAll, afterAll } from "../test-shim";
import { serve, type DevBrowserServer } from "../index";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP = { OK: 200, BAD_REQUEST: 400, NOT_FOUND: 404, TIMEOUT: 408, SERVER_ERROR: 500 } as const;
const VIEWPORT = { WIDTH: 1024, HEIGHT: 768 } as const;
const PORT = 19222;
const CDP_PORT = 19223;
const BASE = `http://localhost:${PORT}`;
const PAGE = "test";
const TEST_PAGE_URL = pathToFileURL(join(__dirname, "test-page.html")).href;

let server: DevBrowserServer;
let profileDir: string;

// Wrapper around fetch().Response. `.json()` is widened to `any` because tests
// inspect server-shaped JSON without per-route type definitions.
interface TestResponse { status: number; json(): Promise<any>; }
async function api(method: string, path: string, body?: unknown): Promise<TestResponse> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, opts);
  return { status: r.status, json: () => r.json() as Promise<any> };
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
  profileDir = mkdtempSync(join(tmpdir(), "dev-browser-test-"));
  server = await serve({ port: PORT, headless: true, cdpPort: CDP_PORT, profileDir });
}, 60000);

afterAll(async (): Promise<void> => {
  if (server) await server.stop();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { void 0; /* cleanup: ignore server shutdown errors */ }
}, 30000);

// ── Server Lifecycle ──────────────────────────────────────────────

describe("Server Lifecycle", (): void => {
  test("GET / returns wsEndpoint", async (): Promise<void> => {
    const res = await api("GET", "/");
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.wsEndpoint).toBeDefined();
    expect(data.wsEndpoint).toMatch(/^ws:\/\//);
  });

  test("GET /health returns 200", async (): Promise<void> => {
    const res = await api("GET", "/health");
    expect(res.status).toBe(HTTP.OK);
  });
});

// ── Page Management ───────────────────────────────────────────────

describe("Page Management", (): void => {
  test("POST /pages creates a page", async (): Promise<void> => {
    const res = await api("POST", "/pages", { name: PAGE });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.name).toBe(PAGE);
    expect(data.wsEndpoint).toBeDefined();
    expect(data.targetId).toBeDefined();
  });

  test("GET /pages lists pages", async (): Promise<void> => {
    const res = await api("GET", "/pages");
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.pages).toContain(PAGE);
  });

  test("POST /pages returns existing page on second call", async (): Promise<void> => {
    const res1 = await api("POST", "/pages", { name: PAGE });
    const data1 = await res1.json();
    const res2 = await api("POST", "/pages", { name: PAGE });
    const data2 = await res2.json();
    expect(data2.targetId).toBe(data1.targetId);
  });

  test("POST /pages with missing name returns 400", async (): Promise<void> => {
    const res = await api("POST", "/pages", {});
    expect(res.status).toBe(HTTP.BAD_REQUEST);
  });

  test("DELETE /pages/:name closes page", async (): Promise<void> => {
    await api("POST", "/pages", { name: "temp" });
    const res = await api("DELETE", "/pages/temp");
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(true);

    const list = await api("GET", "/pages");
    const listData = await list.json();
    expect(listData.pages).not.toContain("temp");
  });

  test("DELETE /pages/:name for non-existent returns 404", async (): Promise<void> => {
    const res = await api("DELETE", "/pages/nonexistent");
    expect(res.status).toBe(HTTP.NOT_FOUND);
  });
});

// ── Navigation ────────────────────────────────────────────────────

describe("Navigation", (): void => {
  test("POST /pages/:name/goto navigates to URL", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/goto`, { url: TEST_PAGE_URL });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.title).toBe("Dev Browser Test Page");
    expect(data.url).toContain("test-page.html");
    expect(data.state).toBeDefined();
  });

  test("goto response includes page state", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/goto`, { url: TEST_PAGE_URL });
    const data = await res.json();
    // State should report form fields and buttons
    expect(data.state).toContain("username");
    expect(data.state).toContain("Submit Form");
  });

  test("POST /pages/:name/goto with missing url returns 400", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/goto`, {});
    expect(res.status).toBe(HTTP.BAD_REQUEST);
    const data = await res.json();
    expect(data.error).toContain("url is required");
  });

  test("GET /pages/:name/url returns current URL", async (): Promise<void> => {
    const res = await api("GET", `/pages/${PAGE}/url`);
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.url).toContain("test-page.html");
    expect(data.name).toBe(PAGE);
  });
});

// ── ARIA Snapshot ─────────────────────────────────────────────────

let ariaSnapshot = "";

describe("ARIA Snapshot", (): void => {
  test("POST /pages/:name/aria returns snapshot with refs", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/aria`);
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.snapshot).toBeDefined();
    ariaSnapshot = data.snapshot;
  });

  test("snapshot contains expected elements", (): void => {
    expect(ariaSnapshot).toContain("heading");
    expect(ariaSnapshot).toContain("Test Page");
    expect(ariaSnapshot).toContain("textbox");
    expect(ariaSnapshot).toContain("button");
    expect(ariaSnapshot).toContain("link");
    expect(ariaSnapshot).toContain("checkbox");
    expect(ariaSnapshot).toContain("combobox");
    expect(ariaSnapshot).toMatch(/\[ref=e\d+\]/);
  });
});

// ── Click ─────────────────────────────────────────────────────────

describe("Click", (): void => {
  test("click by button text", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/click`, { target: "Click Me" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.clicked).toBe("Click Me");
    expect(data.type).toBe("button");

    // Verify side effect
    const textRes = await api("POST", `/pages/${PAGE}/text`, { target: "#result" });
    const textData = await textRes.json();
    expect(textData.text).toBe("Button clicked!");
  });

  test("click by link text", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/click`, { target: "Section 1" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.clicked).toBe("Section 1");
    expect(data.type).toBe("link");
  });

  test("click by CSS selector", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/click`, { target: "#counter-btn" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.clicked).toBe("#counter-btn");
    expect(data.type).toBe("selector");

    const textRes = await api("POST", `/pages/${PAGE}/text`, { target: "#result" });
    const textData = await textRes.json();
    expect(textData.text).toContain("Count:");
  });

  test("click by ARIA ref", async (): Promise<void> => {
    // Refresh ARIA snapshot to get current refs
    const ariaRes = await api("POST", `/pages/${PAGE}/aria`);
    const ariaData = await ariaRes.json();
    const ref = findRef(ariaData.snapshot, "Click Me");
    expect(ref).toBeTruthy();

    const res = await api("POST", `/pages/${PAGE}/click`, { target: ref! });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.clicked).toBe(ref);
    expect(data.type).toBe("ref");
  });

  test("click with force: true", async (): Promise<void> => {
    const ariaRes = await api("POST", `/pages/${PAGE}/aria`);
    const ariaData = await ariaRes.json();
    const ref = findRef(ariaData.snapshot, "Role Button");
    expect(ref).toBeTruthy();

    const res = await api("POST", `/pages/${PAGE}/click`, { target: ref!, force: true });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.type).toBe("ref");
  });

  test("click non-existent target returns 500", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/click`, { target: "#does-not-exist-xyz" });
    expect(res.status).toBe(HTTP.SERVER_ERROR);
  });
});

// ── Fill ──────────────────────────────────────────────────────────

describe("Fill", (): void => {
  test("fill text input by name", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/fill`, { target: "username", value: "testuser" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.filled).toBe("username");
    expect(data.value).toBe("testuser");
  });

  test("fill by ARIA ref", async (): Promise<void> => {
    const ariaRes = await api("POST", `/pages/${PAGE}/aria`);
    const ariaData = await ariaRes.json();
    const ref = findRef(ariaData.snapshot, "Email");
    expect(ref).toBeTruthy();

    const res = await api("POST", `/pages/${PAGE}/fill`, { target: ref!, value: "test@example.com" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.filled).toBe(ref);
    expect(data.value).toBe("test@example.com");
  });

  test("fill checkbox by ARIA ref", async (): Promise<void> => {
    const ariaRes = await api("POST", `/pages/${PAGE}/aria`);
    const ariaData = await ariaRes.json();
    const ref = findRef(ariaData.snapshot, "I agree");
    expect(ref).toBeTruthy();

    const res = await api("POST", `/pages/${PAGE}/fill`, { target: ref!, value: "true" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.filled).toBe(ref);
  });

  test("fill select by ARIA ref", async (): Promise<void> => {
    const ariaRes = await api("POST", `/pages/${PAGE}/aria`);
    const ariaData = await ariaRes.json();
    const ref = findRef(ariaData.snapshot, "Country");
    expect(ref).toBeTruthy();

    const res = await api("POST", `/pages/${PAGE}/fill`, { target: ref!, value: "pl" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.filled).toBe(ref);
  });

  test("fill non-existent field returns 404", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/fill`, { target: "nonexistent-field-xyz", value: "test" });
    expect(res.status).toBe(HTTP.NOT_FOUND);
  });
});

// ── Select ────────────────────────────────────────────────────────

describe("Select", (): void => {
  test("select option by field name", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/select`, { target: "country", value: "us" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.selected).toBe("country");
    expect(data.value).toBe("us");
  });

  test("select by ARIA ref", async (): Promise<void> => {
    const ariaRes = await api("POST", `/pages/${PAGE}/aria`);
    const ariaData = await ariaRes.json();
    const ref = findRef(ariaData.snapshot, "Country");
    expect(ref).toBeTruthy();

    const res = await api("POST", `/pages/${PAGE}/select`, { target: ref!, value: "uk" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.selected).toBe(ref);
  });
});

// ── Text ──────────────────────────────────────────────────────────

describe("Text", (): void => {
  test("get text by CSS selector", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/text`, { target: "#intro" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.text).toContain("test page for dev-browser");
  });

  test("get text by ARIA ref", async (): Promise<void> => {
    const ariaRes = await api("POST", `/pages/${PAGE}/aria`);
    const ariaData = await ariaRes.json();
    const ref = findRef(ariaData.snapshot, "Submit Form");
    expect(ref).toBeTruthy();

    const res = await api("POST", `/pages/${PAGE}/text`, { target: ref! });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.text).toBe("Submit Form");
  });

  test("text for non-existent selector returns 404", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/text`, { target: "#nonexistent-xyz" });
    expect(res.status).toBe(HTTP.NOT_FOUND);
  });
});

// ── Keys ──────────────────────────────────────────────────────────

describe("Keys", (): void => {
  test("type text into focused field", async (): Promise<void> => {
    // Focus the username field first
    await api("POST", `/pages/${PAGE}/click`, { target: "#username" });
    // Clear it
    await api("POST", `/pages/${PAGE}/evaluate`, {
      code: 'document.getElementById("username").value = ""',
    });

    const res = await api("POST", `/pages/${PAGE}/keys`, { keys: "hello" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.action).toBe("typed");
    expect(data.keys).toBe("hello");

    // Verify text was typed
    const textRes = await api("POST", `/pages/${PAGE}/evaluate`, {
      code: 'document.getElementById("username").value',
    });
    const textData = await textRes.json();
    expect(textData.result).toBe("hello");
  });

  test("press special key (Enter)", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/keys`, { keys: "Enter" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.action).toBe("pressed");
  });

  test("press key combination (Control+a)", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/keys`, { keys: "Control+a" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.action).toBe("pressed");
  });

  test("keys with missing keys returns 400", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/keys`, {});
    expect(res.status).toBe(HTTP.BAD_REQUEST);
  });
});

// ── JS Click ─────────────────────────────────────────────────────

describe("JS Click", (): void => {
  test("jsclick by button text triggers JS handler", async (): Promise<void> => {
    // Reset result div
    await api("POST", `/pages/${PAGE}/evaluate`, { code: "document.getElementById('result').textContent = ''" });
    const res = await api("POST", `/pages/${PAGE}/jsclick`, { target: "Click Me" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.jsclicked).toBe("Click Me");
    expect(data.type).toBe("button");
    // Verify JS handler actually fired
    const textRes = await api("POST", `/pages/${PAGE}/text`, { target: "#result" });
    const textData = await textRes.json();
    expect(textData.text).toBe("Button clicked!");
  });

  test("jsclick by CSS selector", async (): Promise<void> => {
    await api("POST", `/pages/${PAGE}/evaluate`, { code: "document.getElementById('result').textContent = ''" });
    const res = await api("POST", `/pages/${PAGE}/jsclick`, { target: "#counter-btn" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.type).toBe("selector");
    const textRes = await api("POST", `/pages/${PAGE}/text`, { target: "#result" });
    const textData = await textRes.json();
    expect(textData.text).toContain("Count:");
  });

  test("jsclick by ARIA ref", async (): Promise<void> => {
    const ariaRes = await api("POST", `/pages/${PAGE}/aria`);
    const ariaData = await ariaRes.json();
    const ref = findRef(ariaData.snapshot, "Role Button");
    expect(ref).toBeTruthy();
    await api("POST", `/pages/${PAGE}/evaluate`, { code: "document.getElementById('result').textContent = ''" });
    const res = await api("POST", `/pages/${PAGE}/jsclick`, { target: ref! });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.type).toBe("ref");
    const textRes = await api("POST", `/pages/${PAGE}/text`, { target: "#result" });
    const textData = await textRes.json();
    expect(textData.text).toBe("Role button clicked!");
  });

  test("jsclick non-existent target returns 404", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/jsclick`, { target: "NonExistent12345" });
    expect(res.status).toBe(HTTP.NOT_FOUND);
  });

  test("jsclick with missing target returns 400", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/jsclick`, {});
    expect(res.status).toBe(HTTP.BAD_REQUEST);
  });
});

// ── Wait ─────────────────────────────────────────────────────────

describe("Wait", (): void => {
  test("wait for existing CSS selector succeeds", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/wait`, { target: "#action-btn" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.found).toContain("#action-btn");
  });

  test("wait for existing text succeeds", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/wait`, { target: "test page for dev-browser" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.found).toContain("test page for dev-browser");
  });

  test("wait for non-existent element times out", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/wait`, { target: "#nonexistent-xyz", timeout: 1000 });
    expect(res.status).toBe(HTTP.TIMEOUT);
  });

  test("wait with missing target returns 400", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/wait`, {});
    expect(res.status).toBe(HTTP.BAD_REQUEST);
  });
});

// ── Screenshot ────────────────────────────────────────────────────

describe("Screenshot", (): void => {
  test("POST /pages/:name/screenshot saves file", async (): Promise<void> => {
    const screenshotPath = `/tmp/dev-browser-test-${Date.now()}.png`;
    const res = await api("POST", `/pages/${PAGE}/screenshot`, { path: screenshotPath });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.path).toBe(screenshotPath);
    expect(existsSync(screenshotPath)).toBe(true);
    try { unlinkSync(screenshotPath); } catch { void 0; /* cleanup: ignore server shutdown errors */ }
  });
});

// ── Evaluate ──────────────────────────────────────────────────────

describe("Evaluate", (): void => {
  test("runs JS and returns result", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/evaluate`, { code: "document.title" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.result).toBe("Dev Browser Test Page");
  });

  test("returns error for throwing JS", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/evaluate`, { code: "throw new Error('test error')" });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("test error");
  });
});

// ── Resize ────────────────────────────────────────────────────────

describe("Resize", (): void => {
  test("POST /pages/:name/resize changes viewport", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/resize`, { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT });
    expect(res.status).toBe(HTTP.OK);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.width).toBe(VIEWPORT.WIDTH);
    expect(data.height).toBe(VIEWPORT.HEIGHT);
  });

  test("resize with missing dimensions returns 400", async (): Promise<void> => {
    const res = await api("POST", `/pages/${PAGE}/resize`, {});
    expect(res.status).toBe(HTTP.BAD_REQUEST);
  });
});
