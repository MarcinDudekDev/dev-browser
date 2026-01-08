// Get all links from current page (use "all" arg to skip limit)
const client = await connect();
const page = await client.page("main");
const args = (process.env.SCRIPT_ARGS || '').trim();
const showAll = args === 'all';
const limit = showAll ? 999 : 50;

const links = await page.evaluate((limit: number) => {
    const seen = new Set<string>();
    return Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({
            href: a.getAttribute('href') || '',
            text: a.textContent?.trim().substring(0, 60) || '',
            inNav: !!a.closest('nav, header, [role="navigation"]')
        }))
        .filter(l => {
            if (!l.href || l.href === '#' || l.href.startsWith('javascript:') || l.href.startsWith('mailto:')) return false;
            if (seen.has(l.href)) return false;
            seen.add(l.href);
            return true;
        })
        .slice(0, limit)
        .map(l => ({ text: l.text || null, href: l.href, nav: l.inNav || undefined }));
}, limit);

console.log(JSON.stringify({
    url: page.url(),
    count: links.length,
    limited: !showAll && links.length >= limit,
    links
}, null, 2));

await client.disconnect();
