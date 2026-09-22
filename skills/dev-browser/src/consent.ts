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

// Google's long-standing id for the reject button (accept is #L2AGLb).
const REJECT_BUTTON = "button#W0wltc";

// The dialog shell: the aria-modal role pair, or the observed container id.
const GOOGLE_DIALOG = '[role="dialog"][aria-modal="true"], #xe7COe';

// Language-independent tell that a dialog is Google's and not another
// vendor's cookie bar — every locale of this modal links to the policy site.
const GOOGLE_SIGNAL = 'a[href*="policies.google.com"]';

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

// RTL locales ship bidi isolate/format marks inside button labels; strip them
// along with whitespace before comparing.
function normalize(text: string | null): string {
  return (text ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// A click that may fail quietly: hidden, covered or detached elements mean
// "couldn't reject", i.e. null — never a crash. Once the click lands we wait
// (event-based, bounded) for the button to go away with its dialog; a dialog
// that lingers does not undo the click, so that wait can't flip the result.
async function clickReject(locator: Locator): Promise<boolean> {
  try {
    if (!(await locator.isVisible())) return false;
    await locator.click({ timeout: 3000 });
  } catch {
    return false;
  }
  await locator.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
  return true;
}

export async function dismissGoogleAccountConsent(page: Page): Promise<string | null> {
  // Clause 1: by id. #W0wltc has named Google's "Reject all" for years; when
  // present it decides regardless of what language the label is in.
  if (await clickReject(page.locator(REJECT_BUTTON).first())) {
    return "Google account consent (Reject all, by id)";
  }

  // Clause 2: the ids rotated. The surviving fingerprint is structural — an
  // aria-modal dialog that links to policies.google.com. Inside it, reject is
  // the button whose label reads "Reject all" in a known language; an
  // unreadable dialog stays up, because guessing could mean accepting.
  try {
    const dialogs = page.locator(GOOGLE_DIALOG);
    const dialogCount = await dialogs.count();
    for (let d = 0; d < dialogCount; d++) {
      const dialog = dialogs.nth(d);
      if (await dialog.locator(GOOGLE_SIGNAL).count() === 0) continue;
      const buttons = dialog.locator("button");
      const n = await buttons.count();
      for (let i = 0; i < n; i++) {
        const btn = buttons.nth(i);
        const label = await btn.innerText({ timeout: 2000 }).catch(() => null);
        if (!REJECT_ALL_TEXTS.has(normalize(label))) continue;
        if (await clickReject(btn)) return "Google account consent (Reject all, by text)";
      }
    }
  } catch {
    // dialog or page vanished mid-scan — nothing left to dismiss
  }
  return null;
}
