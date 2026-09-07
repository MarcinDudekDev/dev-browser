// Guards -p across --run's re-exec.
//
// --run resolves the script path, then execs `dev-browser.sh <file>`. The
// wrapper resets PAGE_NAME to "main" unless -p is on THAT argv. goto/eval
// never re-exec, so `dev-browser.sh -p live goto URL` hits the live tab while
// the same -p with --run used to inject client.page("main") — a new about:blank
// tab. Reproduced 2026-09-07 (impostor-qa-landing, Bun and tsx).

import { test, describe } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER = join(SKILL_DIR, "dev-browser.sh");
const COMMON = join(SKILL_DIR, "lib", "common.sh");
const SCRIPTS = join(SKILL_DIR, "lib", "scripts.sh");

/** cmd_run with `exec` stubbed, so we see the re-exec argv and never launch a browser. */
function cmdRunExec(pageName: string, extra = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "run-page-name-"));
    const script = join(dir, "probe.ts");
    writeFileSync(script, "console.log(page.url());\n");
    try {
        return execFileSync(
            "bash",
            [
                "-c",
                `
set -e
exec() { printf 'EXEC:%s\\n' "$*"; exit 0; }
DEV_BROWSER_DIR="${SKILL_DIR}"
source "${COMMON}" >/dev/null
source "${SCRIPTS}"
PAGE_NAME="$1"
QUIET_CONSOLE="\${QUIET_CONSOLE:-0}"
CACHEBUST_FLAG="\${CACHEBUST_FLAG:-0}"
${extra}
cmd_run "$2"
`,
                "_",
                pageName,
                script,
            ],
            { encoding: "utf8", env: { ...process.env } },
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("--run keeps -p across re-exec", () => {
    test("cmd_run re-execs with -p so PAGE_NAME is not reset to main", () => {
        const out = cmdRunExec("impostor-qa-recon");
        assert.match(out, /^EXEC:/m, "cmd_run must exec the wrapper (stub captures argv)");
        assert.match(
            out,
            /\s-p\s+impostor-qa-recon\s/,
            "re-exec dropped -p — that is the about:blank bug: wrapper then injects client.page(\"main\")",
        );
        assert.match(out, /probe\.ts/, "re-exec must still run the resolved script file");
    });

    test("cmd_run forwards -q when QUIET_CONSOLE=1", () => {
        const out = cmdRunExec("live", 'QUIET_CONSOLE=1');
        assert.match(out, /(^|\s)-q(\s|$)/, "-q was dropped on --run re-exec");
    });

    test("wrapper default inherits PAGE_NAME instead of resetting to main", () => {
        const src = readFileSync(WRAPPER, "utf8");
        // Unconditional PAGE_NAME="main" is the other half of the bug: even a
        // surviving env var is clobbered on the re-exec that has no -p.
        assert.match(
            src,
            /PAGE_NAME="\$\{PAGE_NAME:-main\}"/,
            'PAGE_NAME must default with ${PAGE_NAME:-main}, not an unconditional "main"',
        );
        assert.doesNotMatch(
            src,
            /^PAGE_NAME="main"/m,
            'unconditional PAGE_NAME="main" clobbers -p on --run re-exec',
        );
    });
});
