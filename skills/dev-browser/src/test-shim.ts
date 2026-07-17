// Vitest-compatible shim over node:test + node:assert.
// Keeps existing test files unchanged while removing the vitest/vite/esbuild
// devDep weight (~35M install). Only implements the API surface used here.

import {
  describe as nodeDescribe,
  test as nodeTest,
  before,
  after,
  beforeEach as nodeBeforeEach,
  afterEach as nodeAfterEach,
} from "node:test";
import { strict as assert } from "node:assert";

export const describe = nodeDescribe;

// Vitest accepts a trailing timeout number on test/hooks; node:test takes
// `{ timeout }` in an options object. Wrap to normalize the call shapes used.
type HookFn = () => void | Promise<void>;
type TestFn = () => void | Promise<void>;

export function beforeAll(fn: HookFn, timeout?: number): void {
  if (typeof timeout === "number") before(fn, { timeout }); else before(fn);
}
export function afterAll(fn: HookFn, timeout?: number): void {
  if (typeof timeout === "number") after(fn, { timeout }); else after(fn);
}
export function beforeEach(fn: HookFn, timeout?: number): void {
  if (typeof timeout === "number") nodeBeforeEach(fn, { timeout }); else nodeBeforeEach(fn);
}
export function afterEach(fn: HookFn, timeout?: number): void {
  if (typeof timeout === "number") nodeAfterEach(fn, { timeout }); else nodeAfterEach(fn);
}
export function test(name: string, fnOrTimeout: TestFn | number, maybeFn?: TestFn): void {
  if (typeof fnOrTimeout === "function") {
    nodeTest(name, fnOrTimeout);
  } else if (typeof fnOrTimeout === "number" && typeof maybeFn === "function") {
    nodeTest(name, { timeout: fnOrTimeout }, maybeFn);
  }
}

// Minimal Vitest expect() — only matchers actually used by the test files.
class Expectation {
  constructor(private actual: unknown, private negate = false) {}
  get not(): Expectation {
    return new Expectation(this.actual, !this.negate);
  }
  private check(cond: boolean, msg: string): void {
    if (this.negate ? cond : !cond) {
      throw new assert.AssertionError({ message: msg, actual: this.actual });
    }
  }
  toBe(expected: unknown): void {
    this.check(Object.is(this.actual, expected), `expected ${String(this.actual)} ${this.negate ? "not " : ""}to be ${String(expected)}`);
  }
  toEqual(expected: unknown): void {
    let eq = false;
    try { assert.deepStrictEqual(this.actual, expected); eq = true; } catch { /* not equal */ }
    this.check(eq, `expected ${this.negate ? "not " : ""}deep equal`);
  }
  toContain(expected: unknown): void {
    const a = this.actual as string | unknown[];
    const has = typeof a === "string"
      ? a.includes(expected as string)
      : Array.isArray(a) && a.includes(expected);
    this.check(has, `expected ${JSON.stringify(this.actual)?.slice(0, 200)} ${this.negate ? "not " : ""}to contain ${JSON.stringify(expected)}`);
  }
  toBeDefined(): void {
    this.check(this.actual !== undefined, `expected value ${this.negate ? "not " : ""}to be defined`);
  }
  toBeTruthy(): void {
    this.check(!!this.actual, `expected ${String(this.actual)} ${this.negate ? "not " : ""}to be truthy`);
  }
  toBeFalsy(): void {
    this.check(!this.actual, `expected ${String(this.actual)} ${this.negate ? "not " : ""}to be falsy`);
  }
  toMatch(re: RegExp | string): void {
    const a = String(this.actual);
    const ok = re instanceof RegExp ? re.test(a) : a.includes(re);
    this.check(ok, `expected ${a.slice(0, 200)} ${this.negate ? "not " : ""}to match ${re}`);
  }
}

export function expect(actual: unknown): Expectation {
  return new Expectation(actual);
}
