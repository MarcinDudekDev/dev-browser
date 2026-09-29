// Chrome profile/process helpers, extracted from index.ts so they are unit-
// testable (chrome-profile.test.ts).
//
// These exist because of a measured incident (2026-09-29): a browser relaunch
// spawned a SECOND Chromium on the same --user-data-dir while the first still
// owned it. The old port-kill used `fuser ${port}/tcp`, which macOS's
// /usr/bin/fuser does not support — it errored into a swallowed catch, the old
// Chrome survived, and the unconditional Singleton* rmSync let the duplicate
// claim the profile anyway.
//
// Round 2 (2026-09-29, independent review): the first cut could still wedge
// permanently on a stale SingletonLock (pid reused by an innocent process →
// throw forever) and could still attach to a FOREIGN browser on first start
// (nothing vetted the CDP port holder before spawn, and connectOverCDP never
// checked WHO answered). The policy below has no "refuse" outcome for the
// lock — every lock shape converges to either "cleared" or "killed our own
// stale browser then cleared" — and the port is refused only when a provably
// foreign process holds it.

import { execFileSync } from "child_process";
import { readFileSync, readlinkSync, rmSync } from "fs";
import { hostname } from "os";
import { join } from "path";

const PORT_FREE_DEADLINE_MS = 5000;
const PROBE_FAILURE_IS_HELD_MS = PORT_FREE_DEADLINE_MS;

/**
 * Whole-argument membership test for a `ps -o command=` line. The 2026-09-29
 * review caught a bare `includes()` matching --user-data-dir=/x/browser-data
 * inside --user-data-dir=/x/browser-data-backup — which would have SIGKILLed a
 * foreign Chrome — while the space-separated form never matched at all. The
 * argument must be bounded by whitespace or the ends of the line.
 */
export function argvContainsArg(commandLine: string, arg: string): boolean {
  const escaped = arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(commandLine);
}

/**
 * Prefix variant of argvContainsArg for `--name=value` flags whose VALUE is
 * open: `--type=` must match `--type=renderer`, `--type=gpu-process`, etc.,
 * so the arg only has to START with the prefix at a word boundary (2026-09-29,
 * issue #4 — Chrome helper processes are recognized by carrying --type=).
 */
export function argvContainsArgPrefix(commandLine: string, argPrefix: string): boolean {
  const escaped = argPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}`).test(commandLine);
}

/**
 * Pids LISTENing on `port`, parsed from `netstat -anv -p tcp` output. fuser
 * cannot map a port to a pid on macOS; netstat -v prints it as field[10].
 *
 * Only LISTEN rows count: ESTABLISHED rows carry the pids of the CLIENTS of a
 * listener (including this server's own connections), so matching them would
 * SIGKILL innocent processes.
 */
export function parseListenPids(netstatOutput: string, port: number): number[] {
  const pids = new Set<number>();
  const suffix = `.${port}`;
  for (const line of netstatOutput.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // LISTEN row: proto rx tx LOCAL remote STATE rxbytes txbytes rhiwat shiwat PID
    if (fields.length <= 10) continue;
    if (fields[5] !== "LISTEN") continue;
    // endsWith(".9225") is the exact match: ".19225" and ".92250" must not match.
    if (!fields[3]!.endsWith(suffix)) continue;
    const pid = Number.parseInt(fields[10]!, 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * Pids LISTENing on `port`, parsed from Linux `ss -ltnp` output: the local
 * address column carries `:` port separators and each row carries `pid=NNNN`
 * in the users:(...) tail. Added 2026-09-29 — `netstat -anv -p tcp` is
 * macOS-only and silently returned [] on Linux, which read as "port free"
 * (SHOULD-FIX 6).
 *
 * The column is located from the header ("Local Address:Port"), NOT hard-coded
 * to fields[3]: `ss` variants that prepend a "Netid" column shift it to
 * fields[4], and a fixed index parsed [] there — again reading "port free"
 * (issue #4 nit, 2026-09-29). With no header line seen, fall back to the first
 * field shaped like a local address for the port — a LISTEN row's peer column
 * is `*`/`[::]:*`, never `:port`.
 */
export function parseSsListenPids(ssOutput: string, port: number): number[] {
  const pids = new Set<number>();
  const suffix = `:${port}`;
  let localCol = -1;
  for (const line of ssOutput.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (localCol === -1) {
      // Header row: "Local" is the first token of the "Local Address:Port"
      // column pair, and its index equals the data column index.
      const idx = fields.indexOf("Local");
      if (idx !== -1) localCol = idx;
    }
    if (!line.includes("LISTEN")) continue;
    const local = localCol !== -1 ? fields[localCol] : fields.find((f): boolean => f.endsWith(suffix));
    if (!local?.endsWith(suffix)) continue;
    const m = /pid=(\d+)/.exec(line);
    if (m) pids.add(Number.parseInt(m[1]!, 10));
  }
  return [...pids];
}

/** Pids printed by Linux `fuser <port>/tcp` (e.g. "9225/tcp:  39885 44546"). */
export function parseFuserPids(fuserOutput: string): number[] {
  const pids = new Set<number>();
  // Drop the "PORT/tcp:" header token, then take every bare integer.
  for (const tok of fuserOutput.replace(/^.*?:/, " ").split(/\s+/)) {
    if (!/^\d+$/.test(tok)) continue;
    const pid = Number.parseInt(tok, 10);
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

function execQuiet(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 });
}

/**
 * Pids LISTENing on `port`, or NULL when the probe itself failed. Callers must
 * treat null as "still held", never as "free" — a failed netstat snapshot
 * reading as empty is what let a launch proceed into a held port (review
 * SHOULD-FIX 4). macOS uses netstat -v; Linux tries `ss -ltnp` first and falls
 * back to `fuser` (the tool the pre-2026-09-29 code used everywhere — still
 * the only option on minimal installs). If NO probe binary exists at all the
 * answer is [] rather than null: nothing can be proven held, and refusing
 * forever would be worse than the tiny launch race it reopens.
 */
export function listenPidsOnPort(port: number): number[] | null {
  if (process.platform === "darwin") {
    try {
      return parseListenPids(execQuiet("netstat", ["-anv", "-p", "tcp"]), port);
    } catch {
      return null;
    }
  }
  try {
    return parseSsListenPids(execQuiet("ss", ["-ltnp"]), port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  try {
    return parseFuserPids(execQuiet("fuser", [`${port}/tcp`]));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string | Buffer };
    if (e.code === "ENOENT") {
      console.warn(`freeCdpPort: no port probe available (ss and fuser both missing) — assuming port ${port} free`);
      return [];
    }
    // fuser exits nonzero when nothing matches; its partial stdout still parses.
    const out = e.stdout == null ? "" : String(e.stdout);
    return out.trim() ? parseFuserPids(out) : [];
  }
}

/** `ps -o command=` for a pid, "" when unreadable — "" never matches an argv test. */
export function argvOfPid(pid: number): string {
  try {
    return execQuiet("ps", ["-o", "command=", "-p", String(pid)]);
  } catch {
    return "";
  }
}

/**
 * The raw target of a profile's SingletonLock ("<hostname>-<pid>"), or null.
 * Chrome writes it as a symlink; a plain file holding the same string means
 * the same thing, so read it before declaring the lock absent.
 */
function singletonLockTarget(userDataDir: string): string | null {
  const lockPath = join(userDataDir, "SingletonLock");
  try {
    return readlinkSync(lockPath);
  } catch {
    try {
      return readFileSync(lockPath, "utf8").trim();
    } catch {
      return null;
    }
  }
}

/**
 * Parsed SingletonLock, or null when the lock is missing/unreadable. The
 * hostname half matters as much as the pid: a profile dir that was renamed,
 * synced or moved between machines carries a lock naming a DIFFERENT host,
 * which is stale by definition (review BLOCKER 1). hostnames contain dashes,
 * so the pid is the part after the LAST dash.
 */
export function singletonLockInfo(userDataDir: string): { pid: number | null; hostname: string | null } | null {
  const target = singletonLockTarget(userDataDir);
  if (target === null || target === "") return null;
  const dash = target.lastIndexOf("-");
  if (dash < 0) return { pid: null, hostname: null };
  const tail = target.slice(dash + 1);
  const pid = /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : null;
  return { pid: pid !== null && pid > 0 ? pid : null, hostname: target.slice(0, dash) || null };
}

/**
 * Pid that owns a profile's SingletonLock, or null. Kept for callers/tests
 * that only need the pid; singletonLockInfo is the full parse.
 */
export function singletonLockPid(userDataDir: string): number | null {
  return singletonLockInfo(userDataDir)?.pid ?? null;
}

/**
 * process.kill(pid, 0) without the throw: EPERM means it exists but is owned
 * by someone else (still alive); ESRCH means gone.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove the three Singleton* marker files unconditionally. */
function clearSingletonMarkers(userDataDir: string): void {
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { rmSync(join(userDataDir, lock), { force: true }); } catch { void 0; /* best-effort cleanup */ }
  }
}

export interface SingletonLockDeps {
  isAlive?: (pid: number) => boolean;
  argvOf?: (pid: number) => string;
  hostname?: () => string;
  kill?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  log?: (msg: string) => void;
}

/**
 * Resolve the profile lock so launch can proceed — with NO "refuse" outcome,
 * because every throw here wedged the server permanently on what was usually
 * just a stale file (review BLOCKER 1, 2026-09-29):
 *
 *  - lock written by a DIFFERENT hostname           → stale, clear it
 *  - lock pid dead / unparseable / lock absent      → stale, clear it
 *  - lock pid alive, argv carries our exact
 *    --user-data-dir AND no --type=                 → OUR stale browser: SIGKILL,
 *    wait for death, clear. A --type= arg marks a renderer/GPU/utility helper —
 *    helpers inherit --user-data-dir (measured 2026-09-29) but are never the
 *    browser process, so a lock pid that is a helper is a recycled pid, not an
 *    owner: clear, do not kill (issue #4, round-2 review SHOULD-FIX 6).
 *  - lock pid alive, argv is anything else          → the pid was recycled to an
 *    innocent process; the lock is stale: log loudly, clear it. A Chrome for a
 *    different profile can never legitimately own THIS profile's lock — Chrome
 *    writes the lock of the profile it actually locked — so there is no live
 *    owner left to refuse on.
 *
 * The only throw is "our own stale browser would not die", which is a real
 * failure, not a stale file — and the port check right after (freeCdpPort)
 * backstops anything this misses.
 */
export async function resolveSingletonLock(userDataDir: string, deps: SingletonLockDeps = {}): Promise<void> {
  const isAlive = deps.isAlive ?? isPidAlive;
  const argvOf = deps.argvOf ?? argvOfPid;
  const host = deps.hostname ?? hostname;
  const kill = deps.kill ?? ((pid: number): void => { process.kill(pid, "SIGKILL"); });
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise<void>((resolve: () => void): void => { setTimeout(resolve, ms); }));
  const deadlineMs = deps.deadlineMs ?? PORT_FREE_DEADLINE_MS;
  const log = deps.log ?? ((msg: string): void => { console.log(msg); });
  const dirArg = `--user-data-dir=${userDataDir}`;

  const info = singletonLockInfo(userDataDir);
  if (info?.hostname && info.hostname !== host()) {
    // Do NOT kill the pid here — on a foreign-written lock the number belongs
    // to another machine's process space; a local pid that collides is innocent.
    log(`SingletonLock names host '${info.hostname}' but this host is '${host()}' — stale lock (profile moved/renamed), clearing`);
    clearSingletonMarkers(userDataDir);
    return;
  }

  const ownerPid = info?.pid ?? null;
  if (ownerPid !== null && isAlive(ownerPid)) {
    const cmd = argvOf(ownerPid);
    if (argvContainsArg(cmd, dirArg) && !argvContainsArgPrefix(cmd, "--type=")) {
      log(`Profile lock held by our stale browser (pid ${ownerPid}) — killing it before relaunch`);
      try { kill(ownerPid); } catch { void 0; /* already exited */ }
      const deadline = Date.now() + deadlineMs;
      while (isAlive(ownerPid) && Date.now() < deadline) await sleep(100);
      if (isAlive(ownerPid)) {
        const msg = `browser pid ${ownerPid} still alive after SIGKILL — cannot safely reclaim profile ${userDataDir}`;
        log(`REFUSING: ${msg}`);
        throw new Error(msg);
      }
    } else {
      log(`SingletonLock points at live pid ${ownerPid} whose argv lacks ${dirArg} (cmd: ${cmd || "unreadable"}) — pid recycled by another process, treating lock as stale`);
    }
  }
  clearSingletonMarkers(userDataDir);
}

export interface FreeCdpPortDeps {
  listPids?: (port: number) => number[] | null;
  argvOf?: (pid: number) => string;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  log?: (msg: string) => void;
}

/**
 * Free the CDP port for our next browser — or refuse to launch.
 *
 * A listener is OURS (SIGKILL it) only when its argv carries BOTH
 * --remote-debugging-port=<port> and our exact --user-data-dir as whole
 * arguments AND no --type= — a --type= arg marks a Chrome helper (renderer/
 * GPU/utility), which inherits both flags but is never the browser process
 * (issue #4, round-2 review SHOULD-FIX 6). Anything else is FOREIGN and
 * refuses the launch with a clear error instead of spawning into a held port
 * (review SHOULD-FIX 3/5: the old code SIGKILLed any listener on cdpPort,
 * which CDP_PORT=9222 would have aimed at the user's real browser; and
 * substring matching confused browser-data with browser-data-backup).
 *
 * One exception before classifying foreign: a pid that already EXITED between
 * the LISTEN snapshot and our check (its argv reads empty or ps just fails)
 * is skipped, not refused — its socket is released or closing, so it is a
 * transient teardown, not a holder (issue #4, round-2 review new finding 4).
 * Only a LIVE pid with non-matching argv is foreign.
 *
 * After the kills we wait until NO listener remains. A failed probe counts as
 * "still held" until the deadline (SHOULD-FIX 4), and a deadline pass throws
 * rather than launching into a port we can't prove is free — that launch would
 * attach to whatever actually holds the port (the 2026-09-29 foreign-attach).
 */
export async function freeCdpPort(cdpPort: number, userDataDir: string, deps: FreeCdpPortDeps = {}): Promise<void> {
  const listPids = deps.listPids ?? listenPidsOnPort;
  const argvOf = deps.argvOf ?? argvOfPid;
  const isAlive = deps.isAlive ?? isPidAlive;
  const kill = deps.kill ?? ((pid: number): void => { process.kill(pid, "SIGKILL"); });
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise<void>((resolve: () => void): void => { setTimeout(resolve, ms); }));
  const deadlineMs = deps.deadlineMs ?? PROBE_FAILURE_IS_HELD_MS;
  const log = deps.log ?? ((msg: string): void => { console.log(msg); });
  const portArg = `--remote-debugging-port=${cdpPort}`;
  const dirArg = `--user-data-dir=${userDataDir}`;

  const foreign: { pid: number; cmd: string }[] = [];
  const first = listPids(cdpPort) ?? [];
  for (const pid of first) {
    if (pid === process.pid) {
      foreign.push({ pid, cmd: "(this dev-browser server)" });
      continue;
    }
    const cmd = argvOf(pid);
    if (argvContainsArg(cmd, portArg) && argvContainsArg(cmd, dirArg) && !argvContainsArgPrefix(cmd, "--type=")) {
      log(`Killing stale browser pid ${pid} holding CDP port ${cdpPort} (argv matches ${dirArg})`);
      try { kill(pid); } catch { void 0; /* pid already exited */ }
    } else if (!isAlive(pid)) {
      // Dead pid in the snapshot — its socket is already released or closing,
      // so it is not a holder. Skipping avoids a false REFUSING during socket
      // teardown (e.g. the next ensureContext right after we SIGKILLed our own
      // orphan); the wait loop below confirms the port actually frees.
      log(`CDP port ${cdpPort} listener pid ${pid} already exited — skipping, not foreign`);
    } else {
      foreign.push({ pid, cmd });
    }
  }
  if (foreign.length > 0) {
    const f = foreign[0]!;
    const msg = `CDP port ${cdpPort} held by foreign pid ${f.pid} (${f.cmd || "argv unreadable"}) — refusing to launch; free the port or pick another CDP_PORT`;
    log(`REFUSING: ${msg}`);
    throw new Error(msg);
  }

  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const pids = listPids(cdpPort);
    // null = probe failed = "unknown" — count it as held, never as free.
    if (pids !== null && pids.length === 0) return;
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  const msg = `CDP port ${cdpPort} still held (or unprobeable) after ${deadlineMs}ms — refusing to launch into a held port`;
  log(`REFUSING: ${msg}`);
  throw new Error(msg);
}
