// Guards the fix for the duplicate-Chromium relaunch bug (measured 2026-09-29):
// a dead-context relaunch left the old Chrome alive — macOS fuser cannot map a
// port to a pid, so the kill silently no-oped — and the unconditional
// Singleton* removal then let a second Chrome claim the profile. These tests
// pin the helpers that replaced both halves of that failure.

import { test, describe } from "node:test";
import assert from "node:assert";
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  argvContainsArg,
  argvContainsArgPrefix,
  freeCdpPort,
  isPidAlive,
  parseFuserPids,
  parseListenPids,
  parseSsListenPids,
  resolveSingletonLock,
  singletonLockInfo,
  singletonLockPid,
} from "./chrome-profile.js";

// Real `netstat -anv -p tcp` shape from macOS (2026-09-29). tcp4 + tcp6 LISTEN
// on the same port are TWO DIFFERENT pids — both must come back, or a
// half-killed pair leaves a browser behind. The ESTABLISHED rows carry client
// pids (99999/88888 stand in for the server's own connections): matching them
// would SIGKILL innocent processes.
const NETSTAT_OUT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat    pid   epid state  options
tcp4       0      0  127.0.0.1.9225         127.0.0.1.59644        ESTABLISHED       585820      1454740  390081  499244  99999      0 00102 0000000c 0000000006c6dcc0 00000080 01000900      2      0 000000
tcp4       0      0  127.0.0.1.9225         *.*                    LISTEN                 0            0  131072  131072  39885      0 00100 00000006 0000000006c049e5 00000000 00000800      1      0 000000
tcp6       0      0  ::1.9225               *.*                    LISTEN                 0            0  131072  131072  44546      0 00100 00000006 0000000006c049e5 00000000 00000800      1      0 000000
tcp4       0      0  127.0.0.1.59644        127.0.0.1.9225         ESTABLISHED      2964236       285916 1815736  146988  88888      0 00102 00000008 0000000006c6dcbf 00000081 04000900      2      0 000000
tcp4       0      0  127.0.0.1.19225        *.*                    LISTEN                 0            0  131072  131072  11111      0 00100 00000006 0000000006c049e5 00000000 00000800      1      0 000000
tcp4       0      0  127.0.0.1.92250        *.*                    LISTEN                 0            0  131072  131072  22222      0 00100 00000006 0000000006c049e5 00000000 00000800      1      0 000000
tcp46      0      0  *.6969                 *.*                    LISTEN                 0            0  131072  131072   1601      0 00100 00000006 0000000006c049e5 00000000 00000800      1      0 000000
`;

// A pid that cannot exist on macOS or Linux (pid_max is far below this), so
// kill(pid, 0) always answers ESRCH — a reliably "dead" owner for lock tests.
const DEAD_PID = 2147483646;

function tmpProfile(): string {
  return mkdtempSync(join(tmpdir(), "chrome-profile-test-"));
}

describe("parseListenPids", () => {
  test("returns both tcp4 and tcp6 listeners on the port, and nothing else", () => {
    assert.deepStrictEqual(parseListenPids(NETSTAT_OUT, 9225).sort(), [39885, 44546]);
  });

  test("ESTABLISHED rows on the same port are ignored — their pids are clients, not the listener", () => {
    const pids = parseListenPids(NETSTAT_OUT, 9225);
    assert.ok(!pids.includes(99999), "killing an ESTABLISHED client pid would murder the server's own connection");
    assert.ok(!pids.includes(88888));
  });

  test("a longer port that merely ENDS in the digits does not match", () => {
    const pids = parseListenPids(NETSTAT_OUT, 9225);
    assert.ok(!pids.includes(11111), ".19225 must not match port 9225");
    assert.ok(!pids.includes(22222), ".92250 must not match port 9225");
    // Sanity: those rows DO parse for their own ports — the rejection is the
    // suffix match, not a broken row.
    assert.deepStrictEqual(parseListenPids(NETSTAT_OUT, 19225), [11111]);
    assert.deepStrictEqual(parseListenPids(NETSTAT_OUT, 92250), [22222]);
  });

  test("duplicate LISTEN rows for one pid collapse to a single entry", () => {
    const row = "tcp4       0      0  127.0.0.1.9225         *.*                    LISTEN                 0            0  131072  131072  39885      0 00100";
    assert.deepStrictEqual(parseListenPids(`${row}\n${row}\n`, 9225), [39885]);
  });
});

describe("singletonLockPid", () => {
  test("reads the pid from a symlink target after the last dash", () => {
    const dir = tmpProfile();
    try {
      symlinkSync("mac.home-44546", join(dir, "SingletonLock"));
      assert.strictEqual(singletonLockPid(dir), 44546);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hostnames with dashes still resolve to the pid", () => {
    const dir = tmpProfile();
    try {
      symlinkSync("my-host-name-123", join(dir, "SingletonLock"));
      assert.strictEqual(singletonLockPid(dir), 123);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing lock returns null", () => {
    const dir = tmpProfile();
    try {
      assert.strictEqual(singletonLockPid(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lock whose target has no pid returns null — unparseable means unowned", () => {
    const dir = tmpProfile();
    try {
      symlinkSync("mac.home-garbage", join(dir, "SingletonLock"));
      assert.strictEqual(singletonLockPid(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isPidAlive", () => {
  test("our own pid is alive", () => {
    assert.strictEqual(isPidAlive(process.pid), true);
  });

  test("an out-of-range pid is dead", () => {
    assert.strictEqual(isPidAlive(DEAD_PID), false);
  });
});

describe("argvContainsArg", () => {
  const CHROME = "/opt/chrome/chrome --remote-debugging-port=9225 --user-data-dir=/x/browser-data --no-first-run";

  test("matches a whole argument in the middle of a command line", () => {
    assert.strictEqual(argvContainsArg(CHROME, "--user-data-dir=/x/browser-data"), true);
    assert.strictEqual(argvContainsArg(CHROME, "--remote-debugging-port=9225"), true);
  });

  test("does NOT match a longer arg that merely STARTS the same — the /x/browser-data vs /x/browser-data-backup case", () => {
    // Review SHOULD-FIX 5: substring matching would have SIGKILLed the Chrome
    // running the BACKUP profile. The char after our arg must be whitespace or
    // end-of-line; "-backup" must not match.
    const backup = "/opt/chrome/chrome --user-data-dir=/x/browser-data-backup --remote-debugging-port=9225";
    assert.strictEqual(argvContainsArg(backup, "--user-data-dir=/x/browser-data"), false);
    // ...and the exact backup arg still matches itself.
    assert.strictEqual(argvContainsArg(backup, "--user-data-dir=/x/browser-data-backup"), true);
  });

  test("a longer port does not match --remote-debugging-port=<port>", () => {
    assert.strictEqual(argvContainsArg("chrome --remote-debugging-port=92250", "--remote-debugging-port=9225"), false);
    assert.strictEqual(argvContainsArg("chrome --remote-debugging-port=19225", "--remote-debugging-port=9225"), false);
  });

  test("matches at the start and at the very end of the line", () => {
    assert.strictEqual(argvContainsArg("--flag=x chrome", "--flag=x"), true);
    assert.strictEqual(argvContainsArg("chrome --flag=x", "--flag=x"), true);
    assert.strictEqual(argvContainsArg("chrome --flag=x2", "--flag=x"), false);
  });
});

describe("argvContainsArgPrefix", () => {
  // --type= is how a Chrome helper (renderer/GPU/utility) is recognized —
  // its value is open, so the test is word-START, not whole-arg (issue #4).
  const RENDERER = "/opt/chrome/chrome --type=renderer --remote-debugging-port=9225 --user-data-dir=/x/browser-data";

  test("matches a --flag=value arg by prefix, value open", () => {
    assert.strictEqual(argvContainsArgPrefix(RENDERER, "--type="), true);
    assert.strictEqual(argvContainsArgPrefix(RENDERER, "--type=renderer"), true);
    assert.strictEqual(argvContainsArgPrefix("--type=gpu-process /x", "--type="), true);
  });

  test("does NOT match a flag that merely CONTAINS the string", () => {
    assert.strictEqual(argvContainsArgPrefix("chrome --suspect-type=x", "--type="), false);
    assert.strictEqual(argvContainsArgPrefix("chrome --user-data-dir=/x", "--type="), false);
  });
});

describe("parseSsListenPids (Linux ss -ltnp)", () => {
  const SS_OUT = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      4096   127.0.0.1:9225      0.0.0.0:*    users:(("chrome",pid=39885,fd=131))
LISTEN 0      4096       [::1]:9225         [::]:*    users:(("chrome",pid=44546,fd=130))
LISTEN 0      4096   127.0.0.1:19225     0.0.0.0:*    users:(("nginx",pid=11111,fd=12))
`;

  test("parses pids from the users:(pid=N) tail, both stacks", () => {
    assert.deepStrictEqual(parseSsListenPids(SS_OUT, 9225).sort(), [39885, 44546]);
    assert.deepStrictEqual(parseSsListenPids(SS_OUT, 19225), [11111]);
  });

  // ss variants that prepend a Netid column shift the local address from
  // fields[3] to fields[4] — a hard-coded index parses [] there and reads as
  // "port free" (issue #4 nit). The column is located via the header.
  const SS_OUT_NETID = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      4096   127.0.0.1:9225      0.0.0.0:*    users:(("chrome",pid=39885,fd=131))
tcp   LISTEN 0      4096       [::1]:9225         [::]:*    users:(("chrome",pid=44546,fd=130))
udp   UNCONN 0      0      127.0.0.1:9225      0.0.0.0:*    users:(("dnsmasq",pid=7777,fd=5))
`;

  test("a leading Netid column is handled — local address found via the header", () => {
    assert.deepStrictEqual(parseSsListenPids(SS_OUT_NETID, 9225).sort(), [39885, 44546]);
  });

  test("no header at all still parses — local address found by its :port shape", () => {
    const headless = `LISTEN 0      4096   127.0.0.1:9225      0.0.0.0:*    users:(("chrome",pid=39885,fd=131))
`;
    assert.deepStrictEqual(parseSsListenPids(headless, 9225), [39885]);
  });

  test("a non-LISTEN row on the same port is ignored — its pid is not the listener", () => {
    const pids = parseSsListenPids(SS_OUT_NETID, 9225);
    assert.ok(!pids.includes(7777), "the UDP UNCONN row must not be treated as a TCP listener");
  });
});

describe("parseFuserPids (Linux fuser fallback)", () => {
  test("parses the pid list after the PORT/tcp: header", () => {
    assert.deepStrictEqual(parseFuserPids("9225/tcp:            39885 44546\n"), [39885, 44546]);
    assert.deepStrictEqual(parseFuserPids(""), []);
  });
});

describe("singletonLockInfo", () => {
  test("returns hostname and pid halves of the lock target", () => {
    const dir = tmpProfile();
    try {
      symlinkSync("mac.home-44546", join(dir, "SingletonLock"));
      assert.deepStrictEqual(singletonLockInfo(dir), { pid: 44546, hostname: "mac.home" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hostnames with dashes: pid is after the LAST dash, host keeps its dashes", () => {
    const dir = tmpProfile();
    try {
      symlinkSync("my-host-name-123", join(dir, "SingletonLock"));
      assert.deepStrictEqual(singletonLockInfo(dir), { pid: 123, hostname: "my-host-name" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSingletonLock", () => {
  function makeLock(dir: string, target: string): void {
    symlinkSync(target, join(dir, "SingletonLock"));
    writeFileSync(join(dir, "SingletonCookie"), "cookie");
  }
  const lockExists = (dir: string): boolean => {
    try { lstatSync(join(dir, "SingletonLock")); return true; } catch { return false; }
  };
  const noop = async (): Promise<void> => { void 0; };

  // Review BLOCKER 1: a live pid that is not our browser cannot own our
  // profile lock — the pid was recycled. The old code THREW on this and wedged
  // the server forever; it must now clear and proceed, killing nothing.
  test("live lock owner that is NOT our browser (reused pid) => stale, cleared, no kill, no throw", async () => {
    const dir = tmpProfile();
    try {
      // process.pid is node — alive, and its argv carries no --user-data-dir.
      makeLock(dir, `${hostname()}-${process.pid}`);
      let killed = -1;
      const logs: string[] = [];
      await resolveSingletonLock(dir, {
        argvOf: () => process.argv.join(" "),   // node binary + script — not Chrome
        kill: (pid) => { killed = pid; },
        sleep: noop,
        log: (m) => { logs.push(m); },
      });
      assert.strictEqual(killed, -1, "must not kill a pid we cannot prove is our browser");
      assert.strictEqual(lockExists(dir), false, "stale lock must be cleared");
      assert.ok(logs.some((m) => m.includes("stale")), "recycled-pid clearing should be logged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Replaces the removed clearStaleSingletonLocks coverage (issue #4 nit):
  // a dead/absent owner means the markers are leftovers — cleared, nothing killed.
  test("lock owner already DEAD => all markers cleared, no kill, no throw", async () => {
    const dir = tmpProfile();
    try {
      makeLock(dir, `${hostname()}-${DEAD_PID}`);
      writeFileSync(join(dir, "SingletonSocket"), "socket");
      let killed = -1;
      await resolveSingletonLock(dir, {
        kill: (pid) => { killed = pid; },
        sleep: noop,
      });
      assert.strictEqual(killed, -1, "a dead owner must never be killed");
      for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        let stillThere = true;
        try { lstatSync(join(dir, lock)); } catch { stillThere = false; }
        assert.strictEqual(stillThere, false, `${lock} must be cleared once its owner is gone`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Same BLOCKER-1 case but where ps cannot even be read — unreadable argv can
  // never prove our ownership, so the lock is stale, not a refusal.
  test("live owner with UNREADABLE argv => stale, cleared, no throw", async () => {
    const dir = tmpProfile();
    try {
      makeLock(dir, `${hostname()}-${process.pid}`);
      await resolveSingletonLock(dir, { argvOf: () => "", sleep: noop });
      assert.strictEqual(lockExists(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lock naming a DIFFERENT hostname => stale, cleared, live pid never touched", async () => {
    const dir = tmpProfile();
    try {
      // Even with a live pid inside, a foreign-host lock is stale: the pid
      // belongs to another machine's process space — do NOT kill local pid.
      makeLock(dir, `other-host-${process.pid}`);
      let killed = -1;
      await resolveSingletonLock(dir, {
        hostname: () => "this-host",
        argvOf: () => `/opt/chrome/chrome --user-data-dir=${dir}`,  // even a matching argv stays untouched
        kill: (pid) => { killed = pid; },
        sleep: noop,
      });
      assert.strictEqual(killed, -1, "a foreign-host lock must not trigger a local kill");
      assert.strictEqual(lockExists(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lock owner carrying our exact --user-data-dir => killed, then cleared", async () => {
    const dir = tmpProfile();
    try {
      makeLock(dir, `${hostname()}-777`);
      const killed: number[] = [];
      let alive = true;
      await resolveSingletonLock(dir, {
        isAlive: () => alive,
        argvOf: () => `/opt/chrome/chrome --remote-debugging-port=9225 --user-data-dir=${dir}`,
        kill: (pid) => { killed.push(pid); alive = false; },
        sleep: noop,
      });
      assert.deepStrictEqual(killed, [777]);
      assert.strictEqual(lockExists(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Issue #4 SHOULD-FIX 6: a --type= in argv marks a Chrome HELPER (renderer/
  // GPU/utility), which inherits our --user-data-dir but is never the browser.
  // A lock pid that is a helper is a recycled pid — clear, do not kill.
  test("lock owner whose argv carries --type= is a helper, not our browser => stale, cleared, NO kill", async () => {
    const dir = tmpProfile();
    try {
      makeLock(dir, `${hostname()}-${process.pid}`);
      let killed = -1;
      await resolveSingletonLock(dir, {
        argvOf: () => `/opt/chrome/chrome --type=renderer --remote-debugging-port=9225 --user-data-dir=${dir}`,
        kill: (pid) => { killed = pid; },
        sleep: noop,
      });
      assert.strictEqual(killed, -1, "a helper pid must never be killed — it is a recycled lock owner");
      assert.strictEqual(lockExists(dir), false, "the stale lock is still cleared");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("owner argv with only a PREFIX-similar dir (browser-data-backup) is NOT ours => stale, no kill", async () => {
    const dir = tmpProfile();
    try {
      makeLock(dir, `${hostname()}-${process.pid}`);
      let killed = -1;
      await resolveSingletonLock(dir, {
        argvOf: () => `/opt/chrome/chrome --user-data-dir=${dir}-backup --remote-debugging-port=9225`,
        kill: (pid) => { killed = pid; },
        sleep: noop,
      });
      assert.strictEqual(killed, -1);
      assert.strictEqual(lockExists(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("our stale browser that refuses to die => throws (a real failure, not a stale file)", async () => {
    const dir = tmpProfile();
    try {
      makeLock(dir, `${hostname()}-777`);
      await assert.rejects(
        resolveSingletonLock(dir, {
          isAlive: () => true,   // SIGKILL never lands
          argvOf: () => `/opt/chrome/chrome --user-data-dir=${dir}`,
          kill: () => { void 0; },
          sleep: noop,
          deadlineMs: 30,
        }),
        /still alive after SIGKILL/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("freeCdpPort", () => {
  const DIR = "/x/browser-data";
  const PORT = 9225;
  const noop = async (): Promise<void> => { void 0; };
  const chromeArgv = `/opt/chrome/chrome --remote-debugging-port=${PORT} --user-data-dir=${DIR}`;

  test("kills only a listener whose argv carries BOTH our port AND our exact user-data-dir", async () => {
    let killed = -1;
    let calls = 0;
    await freeCdpPort(PORT, DIR, {
      listPids: () => (++calls === 1 ? [4242] : []),
      argvOf: () => chromeArgv,
      kill: (pid) => { killed = pid; },
      sleep: noop,
    });
    assert.strictEqual(killed, 4242);
  });

  test("a listener with the right port but a DIFFERENT profile dir => foreign => refuse, no kill", async () => {
    let killed = -1;
    await assert.rejects(
      freeCdpPort(PORT, DIR, {
        listPids: () => [4242],
        argvOf: () => `/opt/chrome/chrome --remote-debugging-port=${PORT} --user-data-dir=/x/browser-data-backup`,
        isAlive: () => true,   // a live foreign pid; without this the fake pid is dead → skipped, not refused
        kill: (pid) => { killed = pid; },
        sleep: noop,
      }),
      /held by foreign pid 4242.*refusing/,
    );
    assert.strictEqual(killed, -1, "a foreign listener must never be SIGKILLed");
  });

  test("a non-Chrome listener (no port arg in argv) => foreign => refuse", async () => {
    await assert.rejects(
      freeCdpPort(PORT, DIR, {
        listPids: () => [4242],
        argvOf: () => "/usr/sbin/nginx -g daemon off;",
        isAlive: () => true,
        sleep: noop,
      }),
      /foreign pid 4242/,
    );
  });

  // Issue #4 SHOULD-FIX 4: a pid that died between the netstat snapshot and
  // our classification is not a holder — its socket is released or closing.
  // Skipping beats a false REFUSING on a transient teardown state.
  test("a listener pid that already EXITED is skipped, not refused — port free on next probe", async () => {
    let calls = 0;
    let killed = -1;
    await freeCdpPort(PORT, DIR, {
      listPids: () => (++calls === 1 ? [4242] : []),
      argvOf: () => "",                 // ps on a dead pid reads empty
      isAlive: () => false,             // ...because it is dead
      kill: (pid) => { killed = pid; },
      sleep: noop,
    });
    assert.strictEqual(killed, -1, "a dead pid is neither killed nor refused");
  });

  test("a LIVE pid with unreadable argv is still foreign => refuse", async () => {
    await assert.rejects(
      freeCdpPort(PORT, DIR, {
        listPids: () => [4242],
        argvOf: () => "",
        isAlive: () => true,            // alive but argv unreadable — cannot prove ours
        sleep: noop,
      }),
      /foreign pid 4242.*argv unreadable/,
    );
  });

  // Issue #4 SHOULD-FIX 6: --type= marks a Chrome helper. Helpers inherit both
  // flags but are never the browser process — never ours to kill.
  test("a listener whose argv carries --type= (helper) is NOT ours => alive => refuse, no kill", async () => {
    let killed = -1;
    await assert.rejects(
      freeCdpPort(PORT, DIR, {
        listPids: () => [4242],
        argvOf: () => `/opt/chrome/chrome --type=renderer --remote-debugging-port=${PORT} --user-data-dir=${DIR}`,
        isAlive: () => true,
        kill: (pid) => { killed = pid; },
        sleep: noop,
      }),
      /foreign pid 4242/,
    );
    assert.strictEqual(killed, -1, "a helper must never be SIGKILLed as the browser");
  });

  test("a helper pid that already exited => skipped, not refused", async () => {
    let calls = 0;
    await freeCdpPort(PORT, DIR, {
      listPids: () => (++calls === 1 ? [4242] : []),
      argvOf: () => `/opt/chrome/chrome --type=renderer --remote-debugging-port=${PORT} --user-data-dir=${DIR}`,
      isAlive: () => false,
      sleep: noop,
    });
  });

  // Review SHOULD-FIX 4: a failed probe read as "free" is what launched into a
  // held port. null must count as held until the deadline, then throw.
  test("netstat/probe failure => treated as HELD, throws after the deadline instead of launching", async () => {
    const started = Date.now();
    await assert.rejects(
      freeCdpPort(PORT, DIR, {
        listPids: () => null,          // probe failed every time
        argvOf: () => "",
        sleep: noop,
        deadlineMs: 40,
      }),
      /still held.*refusing/,
    );
    assert.ok(Date.now() - started >= 40, "must wait out the deadline, not fail fast");
  });

  test("a listener that lingers past the deadline => throw rather than launch into a held port", async () => {
    await assert.rejects(
      freeCdpPort(PORT, DIR, {
        listPids: () => [4242],
        argvOf: () => chromeArgv,      // ours — killed, but the port never frees
        kill: () => { void 0; },
        sleep: noop,
        deadlineMs: 30,
      }),
      /still held/,
    );
  });
});
