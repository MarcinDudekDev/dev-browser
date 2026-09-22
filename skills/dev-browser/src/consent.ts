// Dismisses Google's account-consent modal — the "Before you continue" /
// "Zanim przejdziesz do Google" interstitial, NOT the Funding Choices banner
// the other dismiss-consent strategies handle. Measured live 2026-09-22
// (https://www.google.com/?hl=pl, cookies cleared):
//
//   div#xe7COe[role="dialog"][aria-modal="true"]
//     button#W0wltc  "Odrzuć wszystko"      <- Reject all
//     button#L2AGLb  "Zaakceptuj wszystko"  <- Accept all
//
// No iframe, no <form>, no fc-* classes.
//
// Only "Reject all" is ever clicked. Accepting tracking on the user's behalf
// is not a decision this tool may make — when no reject button can be
// identified the dialog stays up and we return null.
import type { Locator, Page } from "playwright";

// Google's long-standing id for the reject button (accept is #L2AGLb). The id
// is only trusted INSIDE the verified consent dialog below — Google reuses
// its obfuscated-id namespace across surfaces, so a stray #W0wltc on a random
// page is not ours to click no matter what it says.
const REJECT_BUTTON = "button#W0wltc";

// The dialog shell. BOTH arms require the aria-modal role pair: bare #xe7COe
// is just an obfuscated container id Google also stamps on plain layout
// containers, so the id alone must never scope a click.
const GOOGLE_DIALOG =
  '[role="dialog"][aria-modal="true"], #xe7COe[role="dialog"][aria-modal="true"]';

// Language-independent tell that a dialog is Google's and not another
// vendor's cookie bar — every locale of this modal links to the policy site.
// A host check, not a substring: the "/" right after the hostname is what a
// lookalike host (policies.google.com.evil.example) or a parameter echo
// (?u=policies.google.com) cannot satisfy.
const GOOGLE_SIGNAL = 'a[href^="https://policies.google.com/"]';

// "Reject all" in every locale we cover, pre-normalized (lowercase, collapsed
// whitespace). Candidate labels go through normalize() before lookup, so
// casing, stray whitespace and bidi marks never decide the match.
const REJECT_ALL_TEXTS = new Set([
  "reject all",            // en
  "odrzuć wszystko",       // pl
  "alle ablehnen",         // de
  "tout refuser",          // fr
  "rechazar todo",         // es
  "rifiuta tutto",         // it
  "alles afwijzen",        // nl
  "rejeitar tudo",         // pt
  "odmítnout vše",         // cs
  "avvisa alla",           // sv
  "afvis alle",            // da
  "avvis alle",            // nb
  "hylkää kaikki",         // fi
  "refuzați tot",          // ro
  "az összes elutasítása", // hu
  "tümünü reddet",         // tr
  "απόρριψη όλων",         // el
  "відхилити все",         // uk
  "отклонить все",         // ru
]);

// "Accept all" in the same locales. A button wearing one of these labels is
// never clicked, whatever id it carries — the check exists because Google
// rotates the obfuscated ids, so #W0wltc naming reject today proves nothing
// about which button wears it after the next rotation.
const ACCEPT_ALL_TEXTS = new Set([
  "accept all",            // en
  "zaakceptuj wszystko",   // pl
  "alle akzeptieren",      // de
  "tout accepter",         // fr
  "aceptar todo",          // es
  "accetta tutto",         // it
  "alles accepteren",      // nl
  "aceitar tudo",          // pt
  "přijmout vše",          // cs
  "acceptera alla",        // sv
  "accepter alle",         // da
  "godta alle",            // nb
  "hyväksy kaikki",        // fi
  "acceptați tot",         // ro
  "az összes elfogadása",  // hu
  "tümünü kabul et",       // tr
  "αποδοχή όλων",          // el
  "прийняти все",          // uk
  "принять все",           // ru
]);

// RTL locales ship bidi isolate/format marks inside button labels; strip them
// along with whitespace before comparing.
function normalize(text: string | null): string {
  return (text ?? "")
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// A click that may fail quietly: hidden, covered or detached elements mean
// "couldn't reject", i.e. null — never a crash. The click landing is not
// proof the dialog went away, so after it we wait (event-based, bounded) for
// the button to leave. waitFor resolves on detach as well as hide, and a
// dismissal that navigates the page reads as not-visible below — both count
// as gone. Still-visible after the wait means the click dismissed nothing.
async function clickReject(locator: Locator): Promise<boolean> {
  try {
    if (!(await locator.isVisible())) return false;
    await locator.click({ timeout: 3000 });
    await locator.waitFor({ state: "hidden", timeout: 3000 });
    return true;
  } catch {
    return !(await locator.isVisible().catch(() => false));
  }
}

export async function dismissGoogleAccountConsent(page: Page): Promise<string | null> {
  // One overall budget for the whole scan. buttons.count() snapshots N while
  // nth() re-resolves live, so a page churning mid-scan (another session
  // navigating it — the shared-browser model) would otherwise multiply the
  // per-button timeout by every detached button.
  const deadline = Date.now() + 5000;
  try {
    // Both clauses only ever fire inside a verified Google consent dialog —
    // the aria-modal shell carrying a link to policies.google.com on Google's
    // own host. A stray #W0wltc outside it, or a same-shaped third-party
    // modal, is not ours to click.
    const dialogs = page.locator(GOOGLE_DIALOG);
    const dialogCount = await dialogs.count();
    for (let d = 0; d < dialogCount && Date.now() < deadline; d++) {
      const dialog = dialogs.nth(d);
      if ((await dialog.locator(GOOGLE_SIGNAL).count()) === 0) continue;

      // Clause 1: by id. #W0wltc has named Google's "Reject all" for years;
      // when present it decides regardless of the label's language — unless
      // the label is a known Accept string, which means the ids rotated and
      // the text scan below owns this dialog.
      const byId = dialog.locator(REJECT_BUTTON).first();
      const idLabel = normalize(await byId.innerText({ timeout: 500 }).catch(() => null));
      if (!ACCEPT_ALL_TEXTS.has(idLabel) && (await clickReject(byId))) {
        return "Google account consent (Reject all, by id)";
      }

      // Clause 2: the ids rotated. Inside the verified dialog, reject is the
      // button whose label reads "Reject all" in a known language; an
      // unreadable dialog stays up, because guessing could mean accepting.
      const buttons = dialog.locator("button");
      const n = await buttons.count();
      for (let i = 0; i < n && Date.now() < deadline; i++) {
        const btn = buttons.nth(i);
        const label = await btn.innerText({ timeout: 500 }).catch(() => null);
        if (!REJECT_ALL_TEXTS.has(normalize(label))) continue;
        if (await clickReject(btn)) return "Google account consent (Reject all, by text)";
      }
    }
  } catch {
    // dialog or page vanished mid-scan — nothing left to dismiss
  }
  return null;
}
