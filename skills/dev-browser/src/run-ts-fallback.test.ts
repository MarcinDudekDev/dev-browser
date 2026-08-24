// Guards run_ts()'s bun-vs-tsx gate in lib/common.sh.
//
// File scripts run under bun since the Playwright CDP bug was fixed upstream
// (oven-sh/bun#31587, merged 2026-06-17, first released in 1.4.0). But bun 1.3.5
// is still widely on PATH and HANGS on connectOverCDP, so the gate must check the
// VERSION, not merely that a bun binary exists. `command -v bun` is not enough.
//
// These tests fail if the gate is ever weakened back to a presence check, or if
// the tsx fallback is dropped so a missing/old bun crashes instead of degrading.

import { test, describe } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMON = join(SKILL_DIR, "lib", "common.sh");
// Minimal PATH with the core utilities common.sh needs (mkdir, wc, date) but
// deliberately WITHOUT /opt/homebrew/bin, so the real bun is not visible and
// each test controls whether a bun exists.
const BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Run a snippet with lib/common.sh sourced, under a controlled PATH. */
function sh(snippet: string, opts: { path?: string; env?: Record<string, string> } = {}): string {
  return execFileSync("bash", ["-c", `set -e; DEV_BROWSER_DIR="${SKILL_DIR}"; source "${COMMON}" >/dev/null 2>&1; ${snippet}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(opts.path !== undefined ? { PATH: opts.path } : {}),
      ...(opts.env ?? {}),
    },
  }).trim();
}

/** A directory containing a fake `bun` that reports `version` and logs if run. */
function fakeBun(version: string) {
  const dir = mkdtempSync(join(tmpdir(), "fakebun-"));
  const marker = join(dir, "INVOKED");
  const bin = join(dir, "bun");
  writeFileSync(
    bin,
    `#!/bin/bash\nif [[ "$1" == "--version" ]]; then echo "${version}"; exit 0; fi\necho "$@" >> "${marker}"\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin, marker };
}

describe("run_ts bun version gate", () => {
  describe("semver comparison", () => {
    const ge = (a: string, b: string) => sh(`_run_ts_semver_ge "${a}" "${b}" && echo yes || echo no`);

    test("equal version is accepted", () => assert.strictEqual(ge("1.4.0", "1.4.0"), "yes"));
    test("1.3.5 is rejected — it hangs on connectOverCDP", () =>
      assert.strictEqual(ge("1.3.5", "1.4.0"), "no"));
    test("newer patch accepted", () => assert.strictEqual(ge("1.4.1", "1.4.0"), "yes"));

    test("compares numerically, not as strings", () => {
      // String comparison would put "1.10.0" below "1.4.0" and needlessly
      // fall back to tsx on a perfectly good bun.
      assert.strictEqual(ge("1.10.0", "1.4.0"), "yes");
      assert.strictEqual(ge("2.0.0", "1.4.0"), "yes");
    });

    test("a -prerelease suffix does not sink an otherwise-new-enough version", () =>
      assert.strictEqual(ge("1.4.0-canary", "1.4.0"), "yes"));

    test("unparseable version fails CLOSED, not open", () => {
      // The dangerous direction: treating garbage as new enough would send every
      // Playwright script to a bun that may hang.
      assert.strictEqual(ge("", "1.4.0"), "no");
      assert.strictEqual(ge("banana", "1.4.0"), "no");
    });
  });

  describe("binary selection", () => {
    test("a too-old bun on PATH is REJECTED (not merely present)", () => {
      const f = fakeBun("1.3.5");
      try {
        // Must resolve to tsx despite `command -v bun` succeeding.
        assert.strictEqual(sh(`_run_ts_find_bun && echo USING_BUN || echo USING_TSX`, { path: `${f.dir}:${BASE_PATH}` }), "USING_TSX");
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });

    test("a new-enough bun on PATH is selected", () => {
      const f = fakeBun("1.4.0");
      try {
        assert.strictEqual(sh(`_run_ts_find_bun >/dev/null && echo USING_BUN || echo USING_TSX`, { path: `${f.dir}:${BASE_PATH}` }), "USING_BUN");
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });

    test("no bun at all falls back instead of crashing", () => {
      const empty = mkdtempSync(join(tmpdir(), "nobun-"));
      try {
        assert.strictEqual(sh(`_run_ts_find_bun && echo USING_BUN || echo USING_TSX`, { path: `${empty}:${BASE_PATH}` }), "USING_TSX");
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    test("DEV_BROWSER_FORCE_TSX=1 is an escape hatch even with a good bun", () => {
      const f = fakeBun("1.4.0");
      try {
        assert.strictEqual(
          sh(`_run_ts_find_bun && echo USING_BUN || echo USING_TSX`, { path: `${f.dir}:${BASE_PATH}`, env: { DEV_BROWSER_FORCE_TSX: "1" } }),
          "USING_TSX",
        );
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });
  });

  test("an old bun is never EXECUTED, not just deselected", () => {
    // The strongest form of the guard: prove run_ts did not hand the script to
    // a bun that would hang. The fake records every non---version invocation.
    const f = fakeBun("1.3.5");
    const script = join(f.dir, "probe.ts");
    writeFileSync(script, 'console.log("ok");\n');
    try {
      sh(`cd "${SKILL_DIR}"; run_ts "${script}" >/dev/null 2>&1 || true; [[ -f "${f.marker}" ]] && echo BUN_RAN || echo BUN_NOT_RUN`, {
        path: `${f.dir}:${process.env.PATH}`,
      });
      const verdict = sh(`[[ -f "${f.marker}" ]] && echo BUN_RAN || echo BUN_NOT_RUN`);
      assert.strictEqual(verdict, "BUN_NOT_RUN", "run_ts executed a bun older than the CDP fix — the version gate is gone");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
