// Guards the Google account-consent strategy used by builtins/dismiss-consent.ts.
//
// The dialog this covers is NOT the Funding Choices / CMP banner the other five
// strategies handle. Measured live on 2026-09-22 (stealth profile, cookies
// cleared, https://www.google.com/?hl=pl):
//
//   div#xe7COe[role="dialog"][aria-modal="true"]
//     button#W0wltc  "Odrzuć wszystko"     <- Reject all
//     button#L2AGLb  "Zaakceptuj wszystko" <- Accept all
//
// No iframe, no form, no fc-* class — which is exactly why every earlier
// strategy returned "No consent overlay detected" on a page that was nothing
// but this modal.
//
// Two clauses decide, and each fixture below is built so that ONLY ONE of them
// can: the id fixture carries synthetic button text no natural-language list
// will ever match, and the text fixture carries no known ids. Delete either
// clause and exactly one test reds. A fixture that both clauses answer would
// prove nothing (a sibling clause decides it either way).

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect } from "../test-shim";
import { dismissGoogleAccountConsent } from "../consent";

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60000);

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
});

afterEach(async () => {
  await context.close();
});

/**
 * Every button records its own id on click, so we assert on WHICH one was hit.
 * A click also unmounts the enclosing dialog (or the bare button when there is
 * none) — the real modal removes itself on dismissal, and "did it actually go
 * away" is part of what dismissGoogleAccountConsent now reports. A fixture can
 * opt out by setting window.__noDismiss, which models a click that lands but
 * dismisses nothing.
 */
const RECORDER = `<script>
  window.__clicked = [];
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) window.__clicked.push(b.id || b.textContent.trim());
    if (window.__noDismiss) return;
    var d = e.target.closest('[role="dialog"]');
    if (d) d.remove(); else if (b) b.remove();
  });
</script>`;

async function clicked(): Promise<string[]> {
  return await page.evaluate(() => (globalThis as unknown as { __clicked: string[] }).__clicked);
}

/**
 * The real structure, with SYNTHETIC button text. No reject-all word list can
 * match "⟨reject⟩", so only the id clause can pass this one.
 */
const FIXTURE_IDS = `
  <div id="xe7COe" class="HTjtHe" role="dialog" aria-modal="true"
       aria-label="Zanim przejdziesz do wyszukiwarki Google" style="display:block">
    <h1>⟨heading⟩</h1>
    <a href="https://policies.google.com/technologies/cookies">⟨cookies⟩</a>
    <div class="spoKVd">
      <button id="W0wltc" class="tHlp8d">⟨reject⟩</button>
      <button id="L2AGLb" class="tHlp8d">⟨accept⟩</button>
    </div>
  </div>`;

/**
 * Same dialog after Google rotates its obfuscated ids — the language-independent
 * signal left is the policies.google.com link inside an aria-modal dialog. Only
 * the text clause can pass this one.
 */
const FIXTURE_TEXT = `
  <div role="dialog" aria-modal="true" aria-label="Zanim przejdziesz do wyszukiwarki Google">
    <h1>Zanim przejdziesz do Google</h1>
    <a href="https://policies.google.com/technologies/cookies?hl=pl">plików cookie</a>
    <div>
      <button id="aQ4dPf">Odrzuć wszystko</button>
      <button id="bR7xKm">Zaakceptuj wszystko</button>
    </div>
  </div>`;

/** Google's dialog in a language we cannot read. Rejecting is impossible here. */
const FIXTURE_UNREADABLE = `
  <div role="dialog" aria-modal="true">
    <h1>⟨heading⟩</h1>
    <a href="https://policies.google.com/privacy">⟨privacy⟩</a>
    <button id="aQ4dPf">⟨one⟩</button>
    <button id="bR7xKm">⟨two⟩</button>
  </div>`;

/** Somebody else's cookie bar. Not this strategy's job. */
const FIXTURE_OTHER_VENDOR = `
  <div class="cookie-banner">
    <p>We use cookies.</p>
    <button id="reject-me">Reject all</button>
    <button id="accept-me">Accept all</button>
  </div>`;

/**
 * Somebody else's consent modal, in the same aria-modal shape Google uses and
 * with the same button wording. ONLY the policies.google.com link separates it
 * from the real thing — so this fixture is what pins that check. Without it the
 * guard could be deleted and every test here would still pass, which is how a
 * clause ends up load-bearing in the comments and nowhere else.
 */
const FIXTURE_OTHER_VENDOR_MODAL = `
  <div role="dialog" aria-modal="true" aria-label="Cookie preferences">
    <h1>We value your privacy</h1>
    <a href="https://example.com/privacy">Privacy policy</a>
    <button id="reject-me">Reject all</button>
    <button id="accept-me">Accept all</button>
  </div>`;

/**
 * The reject id on a page with no dialog at all. Google reuses its obfuscated
 * id namespace across surfaces, so the id alone must never scope a click —
 * only the verified-dialog check keeps this from firing.
 */
const FIXTURE_STRAY_ID = `
  <button id="W0wltc">Permanently delete account</button>`;

/**
 * A real Google dialog where the W0wltc id has rotated onto the ACCEPT button.
 * The label check is the only thing standing between this and consenting on
 * the user's behalf: the id clause must refuse the accept label and let the
 * text clause find the genuinely reject-labelled sibling.
 */
const FIXTURE_ACCEPT_WEARS_ID = `
  <div id="xe7COe" role="dialog" aria-modal="true"
       aria-label="Zanim przejdziesz do wyszukiwarki Google">
    <a href="https://policies.google.com/technologies/cookies">cookies</a>
    <button id="W0wltc">Zaakceptuj wszystko</button>
    <button id="L2AGLb">Odrzuć wszystko</button>
  </div>`;

/**
 * A dialog linking to a lookalike host — substring href matching passes it,
 * the host check does not. The "Reject all" wording is bait: text matching
 * cannot see that this is not Google's modal, only the link can.
 */
const FIXTURE_EVIL_HOST = `
  <div role="dialog" aria-modal="true">
    <a href="https://policies.google.com.evil.example/x">privacy</a>
    <button id="evil-rej">Reject all</button>
  </div>`;

/**
 * The observed container id without the dialog role. Google stamps obfuscated
 * ids on plain layout containers too, so #xe7COe alone must not scope clicks.
 */
const FIXTURE_ID_NO_ROLE = `
  <div id="xe7COe">
    <a href="https://policies.google.com/privacy">privacy</a>
    <button id="x-rej">Reject all</button>
  </div>`;

/**
 * A genuine policies.google.com link plus real "Reject all" wording — but the
 * container is a plain div, not a dialog. Pins the dialog-shape requirement:
 * mutating GOOGLE_DIALOG to 'div' must turn this red.
 */
const FIXTURE_NO_DIALOG = `
  <div>
    <a href="https://policies.google.com/technologies/cookies">cookies</a>
    <button id="div-rej">Reject all</button>
  </div>`;

/**
 * A real Google dialog whose reject button stays put after the click — a no-op
 * handler, a covered target. The dismissal failed, so the answer must be null;
 * the click is still honestly recorded as attempted.
 */
const FIXTURE_STICKY = `
  <script>window.__noDismiss = true;</script>
  <div role="dialog" aria-modal="true">
    <a href="https://policies.google.com/privacy">privacy</a>
    <button id="sticky-rej">Reject all</button>
  </div>`;

async function setContent(body: string): Promise<void> {
  await page.setContent(`<html><body>${body}${RECORDER}</body></html>`, {
    waitUntil: "domcontentloaded",
  });
}

describe("Google account-consent dialog", () => {
  test("clicks Reject all by its id when the text is unreadable", async () => {
    await setContent(FIXTURE_IDS);
    const result = await dismissGoogleAccountConsent(page);
    expect(await clicked()).toEqual(["W0wltc"]);
    expect(result).toMatch(/Reject/);
  });

  test("never clicks Accept all", async () => {
    await setContent(FIXTURE_IDS);
    await dismissGoogleAccountConsent(page);
    expect(await clicked()).not.toContain("L2AGLb");
  });

  test("falls back to the reject text when the ids have rotated", async () => {
    await setContent(FIXTURE_TEXT);
    const result = await dismissGoogleAccountConsent(page);
    expect(await clicked()).toEqual(["aQ4dPf"]);
    expect(result).toMatch(/Reject/);
  });

  test("declines rather than accepting when no reject button can be identified", async () => {
    await setContent(FIXTURE_UNREADABLE);
    const result = await dismissGoogleAccountConsent(page);
    expect(result).toBe(null);
    expect(await clicked()).toEqual([]);
  });

  test("leaves another vendor's cookie bar alone", async () => {
    await setContent(FIXTURE_OTHER_VENDOR);
    const result = await dismissGoogleAccountConsent(page);
    expect(result).toBe(null);
    expect(await clicked()).toEqual([]);
  });

  test("leaves another vendor's aria-modal consent dialog alone", async () => {
    await setContent(FIXTURE_OTHER_VENDOR_MODAL);
    const result = await dismissGoogleAccountConsent(page);
    expect(result).toBe(null);
    expect(await clicked()).toEqual([]);
  });

  test("ignores the reject id on a page with no dialog", async () => {
    await setContent(FIXTURE_STRAY_ID);
    const result = await dismissGoogleAccountConsent(page);
    expect(result).toBe(null);
    expect(await clicked()).toEqual([]);
  });

  test("never clicks an accept-labelled #W0wltc — falls through to the reject text", async () => {
    await setContent(FIXTURE_ACCEPT_WEARS_ID);
    const result = await dismissGoogleAccountConsent(page);
    expect(await clicked()).toEqual(["L2AGLb"]);
    expect(await clicked()).not.toContain("W0wltc");
    expect(result).toMatch(/Reject/);
  });

  test("ignores a lookalike policies host", async () => {
    await setContent(FIXTURE_EVIL_HOST);
    const result = await dismissGoogleAccountConsent(page);
    expect(result).toBe(null);
    expect(await clicked()).toEqual([]);
  });

  test("ignores the observed container id without the dialog role", async () => {
    await setContent(FIXTURE_ID_NO_ROLE);
    const result = await dismissGoogleAccountConsent(page);
    expect(result).toBe(null);
    expect(await clicked()).toEqual([]);
  });

  test("ignores a genuine policies link outside any dialog", async () => {
    await setContent(FIXTURE_NO_DIALOG);
    const result = await dismissGoogleAccountConsent(page);
    expect(result).toBe(null);
    expect(await clicked()).toEqual([]);
  });

  test("reports failure when the click dismisses nothing", async () => {
    await setContent(FIXTURE_STICKY);
    const result = await dismissGoogleAccountConsent(page);
    expect(result).toBe(null);
    expect(await clicked()).toEqual(["sticky-rej"]);
  });
});
