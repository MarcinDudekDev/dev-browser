// Dismiss cookie consent overlays (Google CMP/FC, CookieBot, OneTrust, generic)
// Usage: dev-browser.sh dismiss-consent
// Tries multiple known consent frameworks in order

const dismissed: string[] = [];

// Strategy 1: Google FC (Funding Choices) - iframe-based
try {
    const fcFrame = page.frameLocator('iframe[src*="googlefc"], iframe[src*="consent.google"]');
    const consentBtn = fcFrame.locator('button').filter({ hasText: /agree|accept|consent|I agree/i }).first();
    if (await consentBtn.count() > 0) {
        await consentBtn.click({ timeout: 3000 });
        dismissed.push("Google FC");
    }
} catch {}

// Strategy 2: Google CMP via page-level buttons
if (dismissed.length === 0) {
    try {
        const cmpBtn = page.locator('[class*="fc-cta-consent"], [class*="fc-primary-button"]').first();
        if (await cmpBtn.count() > 0) {
            await cmpBtn.click({ timeout: 3000 });
            dismissed.push("Google CMP");
        }
    } catch {}
}

// Strategy 3: CookieBot
if (dismissed.length === 0) {
    try {
        const cbBtn = page.locator('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept, [id*="CookiebotDialog"] button[id*="Allow"]').first();
        if (await cbBtn.count() > 0) {
            await cbBtn.click({ timeout: 3000 });
            dismissed.push("CookieBot");
        }
    } catch {}
}

// Strategy 4: OneTrust
if (dismissed.length === 0) {
    try {
        const otBtn = page.locator('#onetrust-accept-btn-handler, .onetrust-close-btn-handler, [class*="ot-sdk-btn"]').first();
        if (await otBtn.count() > 0) {
            await otBtn.click({ timeout: 3000 });
            dismissed.push("OneTrust");
        }
    } catch {}
}

// Strategy 5: Generic consent banners (common patterns)
if (dismissed.length === 0) {
    try {
        // Look for common accept/agree buttons in cookie banners
        const selectors = [
            '[class*="cookie"] button:has-text("Accept")',
            '[class*="cookie"] button:has-text("Agree")',
            '[class*="consent"] button:has-text("Accept")',
            '[id*="cookie"] button:has-text("Accept")',
            '[class*="gdpr"] button:has-text("Accept")',
            'button:has-text("Accept all cookies")',
            'button:has-text("Accept cookies")',
            'button:has-text("Akceptuję")',
            'button:has-text("Zgadzam się")',
        ];
        for (const sel of selectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.count() > 0 && await btn.isVisible()) {
                    await btn.click({ timeout: 3000 });
                    dismissed.push(`Generic (${sel.split(':')[0]})`);
                    break;
                }
            } catch {}
        }
    } catch {}
}

// Strategy 6: JS-based dismissal (remove overlay elements)
if (dismissed.length === 0) {
    const removed = await page.evaluate(() => {
        const selectors = [
            '.fc-consent-root', '#fc-consent-root',
            '#CybotCookiebotDialog',
            '#onetrust-consent-sdk',
            '[class*="cookie-banner"]', '[class*="cookie-consent"]',
            '[class*="consent-banner"]', '[class*="gdpr-banner"]',
        ];
        let count = 0;
        for (const sel of selectors) {
            document.querySelectorAll(sel).forEach(el => { el.remove(); count++; });
        }
        // Also remove any fixed/sticky overlays that might be consent
        document.querySelectorAll('[style*="position: fixed"], [style*="position:fixed"]').forEach(el => {
            if (el.textContent?.match(/cookie|consent|privacy|gdpr/i)) {
                el.remove();
                count++;
            }
        });
        return count;
    });
    if (removed > 0) dismissed.push(`DOM removal (${removed} elements)`);
}

if (dismissed.length > 0) {
    console.log(JSON.stringify({ dismissed: dismissed.join(", "), success: true }));
} else {
    console.log(JSON.stringify({ dismissed: null, message: "No consent overlay detected" }));
}
