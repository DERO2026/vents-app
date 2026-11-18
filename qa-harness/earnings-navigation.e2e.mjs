// End-to-end check, in a real browser against the REAL, unmodified App.tsx
// (qa-harness/full-app/, fixture-backed fakeSupabase.ts: no network, no
// Production, no writes), that VENTS Work's earnings links open the
// withdrawable Earnings tab for a Representative who is NOT an organizer,
// provider or admin, and that organizer and everyday wallet navigation is
// unchanged (PR #111, Batch 1).
//
// Usage (starts the harness server itself if it is not already running):
//   node qa-harness/earnings-navigation.e2e.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://localhost:5199/full-app/?screen=full-app';
let server = null;

async function up() { try { return (await fetch('http://localhost:5199/full-app/')).ok; } catch { return false; } }
if (!(await up())) {
  server = spawn('npx', ['vite', '--config', 'qa-harness/vite.harness.config.ts', '--port', '5199', '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) { console.error('harness server did not start'); process.exit(2); }
}

let fails = 0, passes = 0;
const check = (label, ok, detail = '') => { if (ok) { passes++; console.log(`PASS: ${label}`); } else { fails++; console.error(`FAIL: ${label} ${detail}`); } };

const browser = await chromium.launch();
async function session(as, viewport = { width: 390, height: 844 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(as ? `${BASE}&as=${as}` : BASE, { waitUntil: 'load', timeout: 30000 });
  await page.getByText('You', { exact: true }).last().click();
  await page.getByTestId('profile-vents-work-card').waitFor({ timeout: 15000 });
  return { page, errors };
}
const tab = async (page) => {
  await page.getByTestId('unified-wallet').waitFor({ timeout: 15000 });
  return {
    earnings: await page.getByTestId('wallet-tab-earnings').getAttribute('aria-selected'),
    panelHidden: await page.getByTestId('wallet-panel-earnings').evaluate((el) => el.hidden),
  };
};
const earningsText = (page) => page.getByTestId('wallet-panel-earnings').innerText();

// 1. Representative (not an organizer/provider/admin): VENTS Work -> VENTS Earn -> Withdraw earnings.
{
  const { page, errors } = await session('rep-1');
  await page.getByTestId('profile-vents-work-card').click();
  await page.getByTestId('work-tile-withdrawable').click();
  await page.getByTestId('earn-withdraw').click();
  const t = await tab(page);
  check('representative: Withdraw earnings opens the Earnings tab (selected, panel shown)', t.earnings === 'true' && t.panelHidden === false, JSON.stringify(t));
  await page.getByTestId('earnings-explainer').waitFor({ timeout: 10000 });
  const txt = await earningsText(page);
  check('... the withdrawable ₦50,000 reward and the withdrawal flow are on screen', /50,000/.test(txt) && /Withdraw/i.test(txt), txt.slice(0, 200));
  check('... the Wallet Balance panel is not the one shown', await page.getByTestId('wallet-panel-balance').evaluate((el) => el.hidden) === true);
  await page.getByRole('button', { name: /back/i }).first().click().catch(() => {});
  await page.getByTestId('earn-withdraw').waitFor({ timeout: 10000 }).then(() => check('... Back returns to VENTS Earn', true), () => check('... Back returns to VENTS Earn', false));
  check('representative path: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// 2. Representative: VENTS Work "Earnings wallet" shortcut and the Representative dashboard's Withdraw.
{
  const { page } = await session('rep-1');
  await page.getByTestId('profile-vents-work-card').click();
  await page.getByTestId('shortcut-wallet').click();
  let t = await tab(page);
  check('representative: VENTS Work "Earnings wallet" shortcut opens Earnings', t.earnings === 'true' && t.panelHidden === false, JSON.stringify(t));
  await page.close();
  const s2 = await session('rep-1');
  await s2.page.getByTestId('profile-vents-work-card').click();
  await s2.page.getByTestId('shortcut-representative').click();
  await s2.page.getByTestId('rep-withdraw').click();
  t = await tab(s2.page);
  check('representative: dashboard "Withdraw earnings" opens Earnings', t.earnings === 'true' && t.panelHidden === false, JSON.stringify(t));
  await s2.page.close();
}

// 3. Unchanged: the everyday Profile "Wallet" row still opens Wallet Balance for the representative.
{
  const { page } = await session('rep-1');
  await page.getByText('Wallet', { exact: true }).first().click();
  const t = await tab(page);
  check('unchanged: Profile "Wallet" opens Wallet Balance (not Earnings) for a representative', t.earnings === 'false' && t.panelHidden === true, JSON.stringify(t));
  await page.close();
}

// 4. Unchanged: an organizer's own earnings entry ('wallet') still opens Earnings.
// (The Manage Events sidebar is the desktop layout.)
{
  const { page, errors } = await session(null, { width: 1280, height: 900 });
  await page.getByTestId('profile-vents-work-card').click();
  await page.getByTestId('shortcut-events').click();
  await page.getByText('Earnings', { exact: true }).first().click();
  const t = await tab(page);
  check('unchanged: organizer Manage Events "Earnings" opens Earnings', t.earnings === 'true' && t.panelHidden === false, JSON.stringify(t));
  check('organizer path: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

await browser.close();
if (server) { try { process.kill(-server.pid); } catch {} }
console.log(fails === 0 ? `ALL ${passes} EARNINGS NAVIGATION CHECKS PASSED` : `${fails} CHECK(S) FAILED (${passes} passed)`);
process.exit(fails === 0 ? 0 : 1);
