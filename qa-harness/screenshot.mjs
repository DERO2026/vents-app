import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const screen = process.argv[2] || 'welcome';
const width = parseInt(process.argv[3] || '390', 10);
const height = parseInt(process.argv[4] || '844', 10);
const out = process.argv[5] || `/tmp/qa-${screen}-${width}.png`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

await page.goto(`http://localhost:5199/?screen=${screen}`, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: out, fullPage: false });

console.log('SCREENSHOT:', out);
console.log('ERRORS:', errors.length ? JSON.stringify(errors) : 'none');
await browser.close();
