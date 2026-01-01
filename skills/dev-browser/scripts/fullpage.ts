import { chromium } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  const pages = contexts[0].pages();
  const page = pages[0];
  await page.screenshot({ path: '/tmp/sqaa-fullpage.png', fullPage: true });
  console.log('Screenshot saved to /tmp/sqaa-fullpage.png');
  await browser.close();
}

main();
