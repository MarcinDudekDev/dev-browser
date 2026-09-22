// Guards two failures that cost three sessions an afternoon (msg#4764, #4767,
// #4769) — both of them silent, which is why they were read as a corrupt page
// registry rather than as what they were.
//
// 1. builtins/goto.sh creates the page before navigating, and that step OPENS A
//    BROWSER TAB. It used to get 5 seconds with its result piped to /dev/null,
//    so a slow or wedged server failed INVISIBLY and the navigate that followed
//    reported `Page "<name>" not found`. The error named the registry; the
//    cause was the timeout. Three sessions went looking for the phantom.
//
// 2. `--cleanup --only <name>` prepended the project prefix unconditionally, so
//    passing the fully-qualified name that --tabs prints built
//    <project>-<project>-<page>, matched nothing, and still reported success.
//
// Both tests assert on the narrowest thing available: the specific phrase the
// caller needs to see, and the exact page name the cleanup resolves to.

import { test, describe } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:net";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOTO = join(SKILL_DIR, "builtins", "goto.sh");
const DIAGNOSTICS = join(SKILL_DIR, "lib", "diagnostics.sh");

/**
 * A port that accepts the connection and then says nothing — a wedged server,
 * not a closed one. A refused port would fail in milliseconds and prove
 * nothing about the timeout path.
 */
function blackhole(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const sockets: import("node:net").Socket[] = [];
    const server: Server = createServer((s) => {
      sockets.push(s);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => {
          sockets.forEach((s) => s.destroy());
          server.close();
        },
      });
    });
  });
}

describe("goto.sh page creation", () => {
  test("a server that never answers is reported as such, not as a missing page", async () => {
    const bh = await blackhole();
    let stderr = "";
    let code = 0;
    try {
      // curl's own timeout is 45s; the child is given room to reach it.
      execFileSync("bash", [GOTO], {
        env: {
          ...process.env,
          SERVER_PORT: String(bh.port),
          PROJECT_PREFIX: "testproj",
          PAGE_NAME: "guard",
          SCRIPT_ARGS: "https://example.com/",
        },
        encoding: "utf8",
        timeout: 90000,
      });
    } catch (e) {
      const err = e as { stderr?: string; status?: number };
      stderr = err.stderr ?? "";
      code = err.status ?? 0;
    } finally {
      bh.close();
    }

    assert.strictEqual(code, 1, "a failed creation must exit nonzero");
    assert.match(
      stderr,
      /could not create page "testproj-guard"/,
      "the message must name the page it failed to CREATE",
    );
    assert.match(stderr, /did not answer/, "the message must name the real cause");
    assert.doesNotMatch(
      stderr,
      /not found/,
      'a creation timeout must never be reported as "not found" — that sends the reader to the registry',
    );
  });
});

describe("--cleanup --only name resolution", () => {
  /**
   * Calls the REAL resolve_only_target from lib/diagnostics.sh. Re-deriving
   * the expression here would pass with the fix reverted — a test has to run
   * the code production runs, not a copy that looks like it.
   */
  function resolve(arg: string): string {
    return execFileSync(
      "bash",
      ["-c", `source "${DIAGNOSTICS}"; resolve_only_target "myproj" "${arg}"`],
      { encoding: "utf8" },
    ).trim();
  }

  test("a bare page name gets the project prefix", () => {
    assert.strictEqual(resolve("main"), "myproj-main");
  });

  test("an already-qualified name is not prefixed twice", () => {
    // This is the exact shape --tabs prints, so it is the shape people paste.
    assert.strictEqual(resolve("myproj-main"), "myproj-main");
  });

  test("another project's prefix is left intact rather than stripped", () => {
    // Only OUR prefix is removed: "otherproj-main" is not ours to rewrite, and
    // silently turning it into "myproj-main" would close the wrong tab.
    assert.strictEqual(resolve("otherproj-main"), "myproj-otherproj-main");
  });
});
