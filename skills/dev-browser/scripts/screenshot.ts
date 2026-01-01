import { chromium } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error('No browser contexts found');
    process.exit(1);
  }
  const pages = contexts[0].pages();
  if (pages.length === 0) {
    console.error('No pages found');
    process.exit(1);
  }
  const page = pages[0];
  await page.screenshot({ path: '/tmp/sqaa-test.png', fullPage: true });
  console.log('Screenshot saved to /tmp/sqaa-test.png');
  await browser.close();
}

main();
