// Navigate to URL and inspect page structure
const client = await connect();
const page = await client.page("main");
let url = process.env.SCRIPT_ARGS || process.argv[2] || "about:blank";

// Cache busting - append timestamp to bypass cache
if (process.env.CACHEBUST === '1' && url && url !== 'about:blank') {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}v=${Date.now()}`;
}

await page.goto(url);
await waitForPageLoad(page);

// Gather page info including forms/inputs
const info = await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        id: f.id || null,
        action: f.action || null,
        fields: Array.from(f.querySelectorAll('input, select, textarea')).slice(0, 15).map(el => ({
            tag: el.tagName.toLowerCase(),
            type: (el as HTMLInputElement).type || null,
            name: el.getAttribute('name') || el.id || null,
            id: el.id || null,
            placeholder: (el as HTMLInputElement).placeholder || null
        })).filter(f => f.type !== 'hidden')
    }));

    // Inputs outside forms
    const orphanInputs = Array.from(document.querySelectorAll('input:not(form input), select:not(form select), textarea:not(form textarea)')).slice(0, 10).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type || null,
        name: el.getAttribute('name') || el.id || null,
        id: el.id || null
    })).filter(f => (f as any).type !== 'hidden');

    // Key buttons
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).slice(0, 8).map(el => ({
        text: el.textContent?.trim().substring(0, 40) || (el as HTMLInputElement).value || null,
        id: el.id || null,
        type: (el as HTMLInputElement).type || 'button'
    }));

    // Iframes (useful for Stripe, reCAPTCHA, etc.)
    const iframes = Array.from(document.querySelectorAll('iframe')).slice(0, 5).map(f => ({
        name: f.name || null,
        id: f.id || null,
        src: f.src?.substring(0, 100) || null
    }));

    // Links - filter out noise (anchors, javascript, empty)
    const seen = new Set<string>();
    const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ href: a.getAttribute('href') || '', text: a.textContent?.trim().substring(0, 50) || '' }))
        .filter(l => {
            if (!l.href || l.href === '#' || l.href.startsWith('javascript:') || l.href.startsWith('mailto:')) return false;
            if (seen.has(l.href)) return false;
            seen.add(l.href);
            return true;
        })
        .slice(0, 15)
        .map(l => ({ text: l.text || null, href: l.href }));

    return { forms, orphanInputs, buttons, iframes, links };
});

console.log(JSON.stringify({
    url: page.url(),
    title: await page.title(),
    forms: info.forms.length > 0 ? info.forms : undefined,
    inputs: info.orphanInputs.length > 0 ? info.orphanInputs : undefined,
    buttons: info.buttons.length > 0 ? info.buttons : undefined,
    iframes: info.iframes.length > 0 ? info.iframes : undefined,
    links: info.links.length > 0 ? info.links : undefined
}, null, 2));

await client.disconnect();
