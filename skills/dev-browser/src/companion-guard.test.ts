// Guards the .sh-companion fast path in lib/runscript.sh.
//
// dev-browser runs <name>.sh when it sits next to the <name>.ts you asked for.
// That is deliberate for the shipped commands in builtins/, and a footgun
// everywhere else: on 2026-08-24 a scratch probe.ts ran an unrelated probe.sh
// left in ~/claude-tmp from July and printed its output as if it were the
// caller's own.
//
// These tests fail if that silent substitution ever comes back.

import { test, describe } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNSCRIPT = join(SKILL_DIR, "lib", "runscript.sh");

/** Call resolve_companion() in a real bash, exactly as run_script() does. */
function decide(scriptPath: string, env: Record<string, string> = {}): string {
    return execFileSync(
        "bash",
        ["-c", `source "${RUNSCRIPT}" >/dev/null 2>&1; resolve_companion "$1"`, "_", scriptPath],
        { env: { ...process.env, DEV_BROWSER_DIR: SKILL_DIR, ...env }, encoding: "utf8" },
    ).trim();
}

/** Write a .ts and its .sh companion, with explicit mtimes so age is deterministic. */
function pair(dir: string, name: string, opts: { companionAge: "older" | "newer" }) {
    const ts = join(dir, `${name}.ts`);
    const sh = join(dir, `${name}.sh`);
    writeFileSync(ts, "console.log('the script the caller asked for');\n");
    writeFileSync(sh, "echo 'the companion'\n");
    const tsTime = 1_700_000_000;
    const shTime = opts.companionAge === "older" ? tsTime - 86_400 : tsTime + 86_400;
    utimesSync(ts, tsTime, tsTime);
    utimesSync(sh, shTime, shTime);
    return { ts, sh };
}

describe("companion script guard", () => {
    let dir: string;

    test.beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "companion-guard-"));
    });
    test.afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("a stale companion outside builtins/ is REFUSED, never run silently", () => {
        const { ts } = pair(dir, "probe", { companionAge: "older" });
        const decision = decide(ts);

        // The regression this file exists for. If this ever reads "run:",
        // dev-browser is again executing code the caller never named.
        assert.notStrictEqual(
            decision.split(":")[0],
            "run",
            "stale companion was run silently — the probe.ts/probe.sh footgun is back",
        );
        assert.strictEqual(decision.split(":")[0], "refuse");
    });

    test("a fresh companion outside builtins/ still runs, but announces itself", () => {
        const { ts, sh } = pair(dir, "scratch", { companionAge: "newer" });
        const decision = decide(ts);

        // Deliberate scratch pairs must keep working — just not invisibly.
        assert.strictEqual(decision, `announce:${sh}`);
    });

    test("shipped builtins pairs stay silent, so no per-command stderr noise", () => {
        // goto.ts + goto.sh are a real, reviewed pair in builtins/.
        const decision = decide(join(SKILL_DIR, "builtins", "goto.ts"));
        assert.strictEqual(decision, `run:${join(SKILL_DIR, "builtins", "goto.sh")}`);
    });

    test("every shipped builtins companion resolves to silent run", () => {
        const names = ["goto", "click", "fill", "aria", "text", "wait"];
        for (const name of names) {
            const decision = decide(join(SKILL_DIR, "builtins", `${name}.ts`));
            assert.strictEqual(
                decision.split(":")[0],
                "run",
                `builtins/${name} must keep its silent fast path`,
            );
        }
    });

    test("no companion means no companion", () => {
        const ts = join(dir, "lonely.ts");
        writeFileSync(ts, "console.log('hi');\n");
        assert.strictEqual(decide(ts), "none");
    });

    test("the stale refusal has an explicit opt-in escape hatch", () => {
        const { ts, sh } = pair(dir, "onpurpose", { companionAge: "older" });
        assert.strictEqual(
            decide(ts, { DEV_BROWSER_ALLOW_STALE_COMPANION: "1" }),
            `announce:${sh}`,
        );
    });

    test("a missing script file is not treated as a companion match", () => {
        assert.strictEqual(decide(join(dir, "does-not-exist.ts")), "none");
    });
});
