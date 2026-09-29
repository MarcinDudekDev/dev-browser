// Guards the residual relaunch-hang fix (issue #4 comment SHOULD-FIX 1,
// 2026-09-29): a spawned Chrome that accepts TCP but never answers DevTools
// HTTP used to park each bare fetch() on undici's ~300s timeout — x30 retries
// meant launchBrowserContext never returned and every POST /pages hung. These
// tests pin that every attempt is bounded, and that the bound covers the
// .json() body read (headers arriving is not the same as answering).

import { test, describe } from "node:test";
import assert from "node:assert";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchWithRetry } from "./fetch-retry.js";

const ATTEMPT_MS = 150;
const DELAY_MS = 20;
const RETRIES = 3;
// Computed bound for these params: 3 x 150ms attempts + backoff 20x(1+2) = 510ms.
// Assertions use a lax ceiling (timer slack on a loaded machine) — the
// regression being pinned is the ~300s undici default, so seconds vs minutes
// is the signal, not the exact ms.
const LAX_BOUND_MS = 5000;

type Handler = (req: IncomingMessage, res: ServerResponse, requestNumber: number) => void;

interface TestServer {
  url: string;
  close: () => Promise<void>;
  requestCount: () => number;
}

async function startServer(handler: Handler): Promise<TestServer> {
  let requestNumber = 0;
  const server: Server = createServer((req, res): void => { handler(req, res, ++requestNumber); });
  // listen(0) = ephemeral port: tests must not touch the ports real
  // dev-browser/CDP servers may hold (9220-9226, 9290/9291).
  await new Promise<void>((resolve): void => { server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requestCount: (): number => requestNumber,
    close: (): Promise<void> => new Promise<void>((resolve): void => {
      // Hanging handlers keep their sockets open — close() alone would wait
      // for them forever, re-creating the hang inside the test teardown.
      server.closeAllConnections();
      server.close((): void => { resolve(); });
    }),
  };
}

describe("fetchWithRetry", () => {
  test("rejects within the computed bound when the server accepts but never responds", async (t) => {
    const srv = await startServer((): void => { /* the wedged-Chrome shape: accept, never answer */ });
    t.after(srv.close);
    const started = Date.now();
    await assert.rejects(
      fetchWithRetry(srv.url, RETRIES, DELAY_MS, ATTEMPT_MS),
      /Failed after 3 retries/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < LAX_BOUND_MS, `expected < ${LAX_BOUND_MS}ms, took ${elapsed}ms`);
    assert.equal(srv.requestCount(), RETRIES);
  });

  test("resolves when an early attempt hangs but a later one answers 200", async (t) => {
    const srv = await startServer((_req, res, n): void => {
      if (n === 1) return;  // first attempt: accept and never answer
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://x/devtools/browser/abc" }));
    });
    t.after(srv.close);
    const started = Date.now();
    const data = await fetchWithRetry<{ webSocketDebuggerUrl: string }>(
      srv.url, RETRIES, DELAY_MS, ATTEMPT_MS);
    const elapsed = Date.now() - started;
    assert.equal(data.webSocketDebuggerUrl, "ws://x/devtools/browser/abc");
    assert.ok(elapsed < LAX_BOUND_MS, `expected < ${LAX_BOUND_MS}ms, took ${elapsed}ms`);
    assert.equal(srv.requestCount(), 2);
  });

  test("rejects within bound when headers arrive but the body stalls", async (t) => {
    const srv = await startServer((_req, res): void => {
      // AbortSignal.timeout covers the body stream too — flushing headers and
      // then stalling must still abort, or this shape slips past the bound.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      // never write the body, never end
    });
    t.after(srv.close);
    const started = Date.now();
    await assert.rejects(
      fetchWithRetry(srv.url, RETRIES, DELAY_MS, ATTEMPT_MS),
      /Failed after 3 retries/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < LAX_BOUND_MS, `expected < ${LAX_BOUND_MS}ms, took ${elapsed}ms`);
  });
});
