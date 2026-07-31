// Dismiss ALL overlay elements (modals, popups, headers blocking content)
// Enhanced version: removes ALL fixed/absolute elements with high z-index
// Usage: dev-browser.sh dismiss-overlays

const dismissed: string[] = [];

// Strategy 1: Click all close/dismiss buttons
const closeButtons = await page.$$('button');
for (const btn of closeButtons) {
  const text = await btn.textContent();
  const isClose = ['×', 'X', 'Close', 'Dismiss', 'Accept', 'Decline', 'Cancel', 'Got it', 'OK', 'No thanks', 'Maybe later', 'Skip'].some(t =>
    text?.trim() === t || text?.includes(t)
  );
  if (isClose) {
    try {
      await btn.click({ timeout: 500 });
      dismissed.push(`button: ${text?.slice(0, 20)}`);
    } catch {}
  }
}

// Strategy 2: Press Escape key to close any open modals
try {
  await page.keyboard.press('Escape');
  dismissed.push('keyboard: Escape');
} catch {}

// Strategy 3: Remove fixed/absolute positioned overlays via JS (aggressive)
const removed = await page.evaluate(() => {
  const removed: string[] = [];

  // Lower threshold: remove anything with z-index > 1000 that's fixed/absolute
  document.querySelectorAll('*').forEach(el => {
    const style = getComputedStyle(el);
    const zIndex = parseInt(style.zIndex) || 0;
    const isFixed = style.position === 'fixed' || style.position === 'absolute';
    const isBlocking = zIndex > 1000;
    const isNotRoot = el.tagName !== 'HTML' && el.tagName !== 'BODY';

    // Check for common overlay patterns
    const className = el.className?.toString().toLowerCase() || '';
    const id = el.id?.toLowerCase() || '';
    const isOverlayByName =
      className.includes('modal') ||
      className.includes('overlay') ||
      className.includes('popup') ||
      className.includes('dialog') ||
      className.includes('banner') ||
      className.includes('cookie') ||
      className.includes('consent') ||
      className.includes('notification') ||
      id.includes('modal') ||
      id.includes('overlay') ||
      id.includes('popup');

    if (isNotRoot && ((isFixed && isBlocking) || (isFixed && isOverlayByName))) {
      const desc = `${el.tagName}${el.id ? '#' + el.id : ''}.${className.slice(0, 30)}`;
      (el as HTMLElement).remove();
      removed.push(desc);
    }
  });

  // Also disable pointer-events on remaining fixed elements
  document.querySelectorAll('*').forEach(el => {
    const style = getComputedStyle(el);
    if (style.position === 'fixed' && parseInt(style.zIndex || '0') > 100) {
      (el as HTMLElement).style.pointerEvents = 'none';
    }
  });

  // Remove any backdrop/overlay divs covering the page
  document.querySelectorAll('[class*="backdrop"], [class*="overlay"], [class*="mask"]').forEach(el => {
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'absolute') {
      const desc = `backdrop: ${el.tagName}.${el.className?.toString().slice(0, 20)}`;
      (el as HTMLElement).remove();
      removed.push(desc);
    }
  });

  return removed;
});

console.log(JSON.stringify({
  dismissed: dismissed.length,
  removed: removed.length,
  details: [...dismissed, ...removed].slice(0, 15)
}, null, 2));
