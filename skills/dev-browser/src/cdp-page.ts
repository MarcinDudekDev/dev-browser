/**
 * Raw-CDP single-target page driver for `--user` mode.
 *
 * WHY THIS EXISTS: Playwright's `connectOverCDP` attaches to EVERY target in the
 * browser (browser-level `Target.setAutoAttach`) and enables Runtime/Network/Log
 * domains on each. Against a heavy real profile (e.g. 156 targets / 57 live tabs)
 * it drowns in the console/log event flood and never settles — even a 60s connect
 * times out. Measured against a real day-to-day Chrome profile; a fresh profile
 * with a handful of tabs connects fine, which is why this only bites `--user`.
 *
 * THIS DRIVER instead opens a raw CDP WebSocket to the BROWSER endpoint but NEVER
 * calls `Target.setAutoAttach`. It creates its own tab via `Target.createTarget`
 * and attaches ONLY to that one target. The user's other 155 tabs are never
 * attached, never flooded, and never disturbed.
 *
 * It duck-types the subset of the Playwright `Page` / `ElementHandle` API that the
 * server endpoints actually call, so the existing endpoint bodies work unchanged
 * for the navigate / screenshot / aria-snapshot / click-by-ref / fill-by-ref /
 * evaluate flows. Selector-engine methods (`locator`, `getByRole`, `getByText`,
 * `frames`) are NOT supported in user mode and throw a clear error directing the
 * caller to the `aria` snapshot + ref (e1, e5, ...) workflow.
 */
import { writeFileSync } from "fs";

interface RemoteObject {
  objectId?: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
}

type CDPEventHandler = (params: Record<string, unknown>) => void;

/** One browser-level CDP WebSocket, multiplexing commands across attached sessions. */
export class CDPConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  // sessionId ("" = browser session) -> method -> handlers
  private listeners = new Map<string, Map<string, Set<CDPEventHandler>>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.onmessage = (ev: MessageEvent): void => this.onMessage(String(ev.data));
  }

  static async connect(browserWsUrl: string, timeoutMs = 10000): Promise<CDPConnection> {
    const ws = new WebSocket(browserWsUrl);
    await new Promise<void>((resolve, reject): void => {
      const t = setTimeout((): void => reject(new Error(`CDP WS connect timed out after ${timeoutMs}ms`)), timeoutMs);
      ws.onopen = (): void => { clearTimeout(t); resolve(); };
      ws.onerror = (): void => { clearTimeout(t); reject(new Error("CDP WS connection error")); };
    });
    return new CDPConnection(ws);
  }

  private onMessage(data: string): void {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      const sid = msg.sessionId || "";
      const byMethod = this.listeners.get(sid);
      const set = byMethod?.get(msg.method);
      if (set) for (const h of set) { try { h(msg.params || {}); } catch { /* handler error: ignore */ } }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject): void => {
      const timer = setTimeout((): void => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)); }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  on(sessionId: string, method: string, handler: CDPEventHandler): void {
    const sid = sessionId || "";
    if (!this.listeners.has(sid)) this.listeners.set(sid, new Map());
    const byMethod = this.listeners.get(sid)!;
    if (!byMethod.has(method)) byMethod.set(method, new Set());
    byMethod.get(method)!.add(handler);
  }

  off(sessionId: string, method: string, handler: CDPEventHandler): void {
    this.listeners.get(sessionId || "")?.get(method)?.delete(handler);
  }

  /**
   * Create a fresh tab and attach ONLY to it via autoAttachRelated — which keeps
   * us attached across cross-process navigations (data:/cross-origin) WITHOUT
   * attaching to any of the user's other targets (no storm). Plain
   * Target.attachToTarget would drop the session on every renderer swap.
   */
  async newPage(): Promise<CDPPage> {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const page = new CDPPage(this, targetId);
    await page.init();
    return page;
  }

  /** Liveness probe used by the /health endpoint. */
  async isAlive(): Promise<boolean> {
    try { await this.send("Target.getTargets", {}, undefined, 3000); return true; }
    catch { return false; }
  }

  /** Set cookies on the user's real browser context (used by /cookies endpoint). */
  async setCookies(cookies: Array<Record<string, unknown>>): Promise<void> {
    await this.send("Storage.setCookies", { cookies });
  }

  /** Close the WS — does NOT quit the user's browser, just detaches our client. */
  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

const USER_MODE_UNSUPPORTED =
  "Not supported in --user mode (single-target raw CDP). Use the 'aria' snapshot " +
  "to get element refs (e1, e5, ...), then click/fill by ref, or use 'eval' to run JS.";

/** A handle to an in-page JS object/element, backed by a CDP RemoteObject. */
export class CDPElementHandle {
  constructor(private conn: CDPConnection, private sessionId: string, private remote: RemoteObject) {}

  /** Mirrors Playwright: returns this if it wraps a DOM node, else null. */
  asElement(): CDPElementHandle | null {
    return this.remote.subtype === "node" ? this : null;
  }

  /** Mirrors Playwright element.evaluate((node, arg) => ...): node is `this`. */
  async evaluate<T = unknown>(fn: (...args: any[]) => T, arg?: unknown): Promise<T> {
    if (!this.remote.objectId) throw new Error("Element handle has no objectId");
    const decl = `function(...a){ return (${fn.toString()}).apply(null, [this, ...a]); }`;
    const { result, exceptionDetails } = await this.conn.send("Runtime.callFunctionOn", {
      functionDeclaration: decl,
      objectId: this.remote.objectId,
      arguments: arg === undefined ? [] : [{ value: arg }],
      returnByValue: true,
      awaitPromise: true,
    }, this.sessionId);
    if (exceptionDetails) throw new Error(describeException(exceptionDetails));
    return result?.value as T;
  }

  async click(): Promise<void> {
    const box = await this.evaluate((node: any): { x: number; y: number; w: number; h: number } => {
      if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "center", inline: "center" });
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    });
    if (!box || box.w === 0 || box.h === 0) throw new Error("Element is not visible (zero-size box) — cannot click");
    await dispatchClick(this.conn, this.sessionId, box.x, box.y);
  }

  async type(text: string): Promise<void> {
    await this.evaluate((node: any): void => { if (node && typeof node.focus === "function") node.focus(); });
    await this.conn.send("Input.insertText", { text }, this.sessionId);
    await this.evaluate((node: any): void => {
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async dispose(): Promise<void> {
    if (this.remote.objectId) {
      await this.conn.send("Runtime.releaseObject", { objectId: this.remote.objectId }, this.sessionId).catch((): void => undefined);
    }
  }
}

/** Duck-types the Playwright `Page` subset used by the server endpoints. */
export class CDPPage {
  readonly targetId: string;
  private conn: CDPConnection;
  private sessionId = "";
  private _url = "about:blank";
  private _closed = false;
  private _viewport: { width: number; height: number } | null = null;
  private _lifecycle = new Set<string>();
  private closeHandlers = new Set<() => void>();
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readyResolvers = new Set<() => void>();
  private attachHandler?: (p: any) => void;
  private detachHandler?: (p: any) => void;

  // playwright code does `page.mouse.click(x, y)`
  readonly mouse: { click: (x: number, y: number) => Promise<void> };

  constructor(conn: CDPConnection, targetId: string) {
    this.conn = conn;
    this.targetId = targetId;
    this.mouse = {
      click: async (x: number, y: number): Promise<void> => { await dispatchClick(this.conn, this.sessionId, x, y); },
    };
  }

  async init(): Promise<void> {
    // Stay attached to OUR tab across renderer swaps; never touch other targets.
    this.attachHandler = (p: any): void => {
      if (p.targetInfo?.targetId === this.targetId) void this.onAttached(p.sessionId);
    };
    // A detach may be a transient process swap (autoAttachRelated re-attaches) OR a
    // genuine close. Debounce: only declare closed if no re-attach arrives shortly.
    this.detachHandler = (p: any): void => {
      if (p.sessionId === this.sessionId) this.scheduleClose();
    };
    this.conn.on("", "Target.attachedToTarget", this.attachHandler);
    this.conn.on("", "Target.detachedFromTarget", this.detachHandler);

    const firstAttach = new Promise<void>((resolve): void => { this.readyResolvers.add(resolve); });
    await this.conn.send("Target.autoAttachRelated", { targetId: this.targetId, waitForDebuggerOnStart: false });
    await Promise.race([
      firstAttach,
      new Promise<void>((_, reject): void => { setTimeout((): void => reject(new Error("CDP attach to new tab timed out")), 10000); }),
    ]);
  }

  /** (Re)attached to our tab — enable domains on the (possibly new) session. */
  private async onAttached(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    this._closed = false;

    this.conn.on(sessionId, "Page.frameNavigated", (p: any): void => {
      if (p.frame && !p.frame.parentId) { this._url = p.frame.url; this._lifecycle.clear(); }
    });
    this.conn.on(sessionId, "Page.navigatedWithinDocument", (p: any): void => {
      if (p.url) this._url = p.url;
    });
    this.conn.on(sessionId, "Page.lifecycleEvent", (p: any): void => {
      if (p.name) this._lifecycle.add(p.name);
    });

    try {
      await this.conn.send("Page.enable", {}, sessionId);
      await this.conn.send("Runtime.enable", {}, sessionId);
      await this.conn.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
      const { result } = await this.conn.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
      if (typeof result?.value === "string") this._url = result.value;
    } catch { /* restricted page (about:blank etc.) — keep defaults */ }
    this._lifecycle.add("DOMContentLoaded");
    this._lifecycle.add("load");

    for (const r of this.readyResolvers) { try { r(); } catch { /* ignore */ } }
    this.readyResolvers.clear();
  }

  private scheduleClose(): void {
    if (this.closeTimer || this._closed) return;
    this.closeTimer = setTimeout((): void => { this.closeTimer = null; this.markClosed(); }, 700);
  }

  private markClosed(): void {
    if (this._closed) return;
    this._closed = true;
    // Remove our browser-level listeners so they don't accumulate across pages.
    if (this.attachHandler) this.conn.off("", "Target.attachedToTarget", this.attachHandler);
    if (this.detachHandler) this.conn.off("", "Target.detachedFromTarget", this.detachHandler);
    for (const h of this.closeHandlers) { try { h(); } catch { /* ignore */ } }
  }

  on(event: string, handler: () => void): void {
    if (event === "close") this.closeHandlers.add(handler);
  }

  isClosed(): boolean { return this._closed; }

  url(): string { return this._url; }

  async title(): Promise<string> {
    return (await this.evaluate((): string => document.title)) || "";
  }

  /** Mirrors Playwright page.evaluate(fn, arg) — fn is called with arg. */
  async evaluate<T = unknown>(fn: ((...args: any[]) => T) | string, arg?: unknown): Promise<T> {
    const decl = typeof fn === "function" ? fn.toString() : `() => (${fn})`;
    const argStr = arg === undefined ? "" : JSON.stringify(arg);
    const expression = `(${decl})(${argStr})`;
    const { result, exceptionDetails } = await this.conn.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    }, this.sessionId);
    if (exceptionDetails) throw new Error(describeException(exceptionDetails));
    return result?.value as T;
  }

  /** Mirrors page.evaluateHandle(fn, arg) — returns a handle, not a value. */
  async evaluateHandle(fn: ((...args: any[]) => unknown) | string, arg?: unknown): Promise<CDPElementHandle> {
    const decl = typeof fn === "function" ? fn.toString() : `() => (${fn})`;
    const argStr = arg === undefined ? "" : JSON.stringify(arg);
    const expression = `(${decl})(${argStr})`;
    const { result, exceptionDetails } = await this.conn.send("Runtime.evaluate", {
      expression, returnByValue: false, awaitPromise: true,
    }, this.sessionId);
    if (exceptionDetails) throw new Error(describeException(exceptionDetails));
    return new CDPElementHandle(this.conn, this.sessionId, result as RemoteObject);
  }

  async goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 30000;
    this._lifecycle.clear();
    const wait = opts?.waitUntil === "load" ? "load" : "DOMContentLoaded";
    const reached = this.waitForLifecycle(wait, timeout);
    const { errorText } = await this.conn.send("Page.navigate", { url }, this.sessionId, timeout);
    if (errorText && errorText !== "net::ERR_ABORTED") throw new Error(errorText);
    await reached;
  }

  async waitForLoadState(state?: string, opts?: { timeout?: number }): Promise<void> {
    const name = state === "load" ? "load" : state === "networkidle" ? "networkIdle" : "DOMContentLoaded";
    await this.waitForLifecycle(name, opts?.timeout ?? 30000);
  }

  private waitForLifecycle(name: string, timeoutMs: number): Promise<void> {
    if (this._lifecycle.has(name)) return Promise.resolve();
    return new Promise<void>((resolve, reject): void => {
      const handler = (p: any): void => {
        if (p.name === name) { cleanup(); resolve(); }
      };
      const timer = setTimeout((): void => { cleanup(); reject(new Error(`waitForLoadState(${name}) timed out after ${timeoutMs}ms`)); }, timeoutMs);
      const cleanup = (): void => { clearTimeout(timer); this.conn.off(this.sessionId, "Page.lifecycleEvent", handler); };
      this.conn.on(this.sessionId, "Page.lifecycleEvent", handler);
    });
  }

  async screenshot(opts?: { path?: string; fullPage?: boolean; type?: string }): Promise<Buffer> {
    const { data } = await this.conn.send("Page.captureScreenshot", {
      format: opts?.type === "jpeg" ? "jpeg" : "png",
      captureBeyondViewport: opts?.fullPage === true,
      fromSurface: true,
    }, this.sessionId);
    const buf = Buffer.from(data, "base64");
    if (opts?.path) writeFileSync(opts.path, buf);
    return buf;
  }

  viewportSize(): { width: number; height: number } | null { return this._viewport; }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    await this.conn.send("Emulation.setDeviceMetricsOverride", {
      width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
    }, this.sessionId);
    this._viewport = { width: size.width, height: size.height };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    try { await this.conn.send("Target.closeTarget", { targetId: this.targetId }); }
    finally { this.markClosed(); }
  }

  // ── Selector-engine surface: unsupported in user mode ──────────────
  locator(): never { throw new Error(USER_MODE_UNSUPPORTED); }
  getByRole(): never { throw new Error(USER_MODE_UNSUPPORTED); }
  getByText(): never { throw new Error(USER_MODE_UNSUPPORTED); }
  frames(): never[] { return []; }
  mainFrame(): never { throw new Error(USER_MODE_UNSUPPORTED); }
}

/** A minimal BrowserContext duck-type so existing endpoints work in user mode. */
export function makeUserContext(conn: CDPConnection): {
  newPage: () => Promise<CDPPage>;
  pages: () => Promise<CDPPage[]>;
  addCookies: (cookies: Array<Record<string, unknown>>) => Promise<void>;
} {
  return {
    newPage: (): Promise<CDPPage> => conn.newPage(),
    pages: async (): Promise<CDPPage[]> => {
      if (!(await conn.isAlive())) throw new Error("CDP connection to user browser is dead");
      return [];
    },
    addCookies: (cookies: Array<Record<string, unknown>>): Promise<void> => conn.setCookies(cookies),
  };
}

// ── helpers ─────────────────────────────────────────────────────────
function describeException(exceptionDetails: any): string {
  return exceptionDetails?.exception?.description
    || exceptionDetails?.exception?.value
    || exceptionDetails?.text
    || "Evaluation failed";
}

async function dispatchClick(conn: CDPConnection, sessionId: string, x: number, y: number): Promise<void> {
  await conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
  await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
}
