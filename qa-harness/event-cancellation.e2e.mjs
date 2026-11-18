// End-to-end check, in a real browser against the REAL, unmodified App.tsx
// (qa-harness/full-app/, fixture-backed fakeSupabase.ts: no network, no
// Production, no writes; fakeSupabase records every rpc() in window.__rpc),
// of the organizer side of event cancellation (0218): an event with ticket
// holders is steered from Delete to a cancellation request, the request
// explains what happens to ticket holders, and the app sends the request
// RPC (never soft_delete_event) with the organizer's reason only.
//
// Usage (starts the harness server itself if it is not already running):
//   node qa-harness/event-cancellation.e2e.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5199/full-app/?screen=full-app', { waitUntil: 'load', timeout: 30000 });
await page.getByText('You', { exact: true }).last().click();
await page.getByTestId('profile-vents-work-card').click();
await page.getByTestId('shortcut-events').click();

const card = page.locator('.vents-manage-card', { hasText: 'Lagos Music Festival' }).first();
await card.waitFor({ timeout: 15000 });
await card.getByRole('button', { name: 'Event options' }).click();
await page.getByRole('button', { name: 'Delete Event' }).click();
const explainer = await page.getByTestId('delete-event-explainer').innerText();
check('Delete on an event with sold tickets explains it cannot be deleted', /can't be deleted\. Request a cancellation instead/.test(explainer), explainer);
check('... and offers no Delete button', (await page.getByRole('button', { name: 'Delete', exact: true }).count()) === 0);
await page.getByTestId('delete-to-cancel').click();

const dialog = page.getByTestId('cancel-event-dialog');
await dialog.waitFor({ timeout: 10000 });
const text = await page.getByTestId('cancel-event-explainer').innerText();
check('the cancellation dialog says sales stay open until approval', text.includes('Ticket sales stay open until it is approved'), text);
check('... that each sold ticket is refunded the way it was paid', /each of the 86 ticket\(s\) sold is refunded the way it was paid/.test(text), text);
check('... and that an approved cancellation cannot be undone', text.includes("can't be undone"), text);

await page.getByTestId('cancel-event-submit').click();
check('a reason is required before anything is sent', (await page.getByTestId('cancel-event-error').innerText()).includes('at least 10 characters'));
await page.getByLabel('Cancellation reason').fill('The venue flooded and is closed for repairs');
await page.getByTestId('cancel-event-submit').click();
await dialog.waitFor({ state: 'detached', timeout: 10000 });
const calls = await page.evaluate(() => window.__rpc || []);
const req = calls.filter((c) => c.fn === 'request_event_cancellation');
check('the app sent request_event_cancellation once, with the event and the organizer\'s reason only', req.length === 1
  && req[0].args.p_event_id === 'evt-1' && req[0].args.p_reason === 'The venue flooded and is closed for repairs'
  && Object.keys(req[0].args).sort().join(',') === 'p_event_id,p_reason', JSON.stringify(req));
check('soft_delete_event was never called', !calls.some((c) => c.fn === 'soft_delete_event'));
check('no page errors', errors.length === 0, errors.join('; '));

await browser.close();
if (server) { try { process.kill(-server.pid); } catch {} }
console.log(fails === 0 ? `ALL ${passes} EVENT CANCELLATION BROWSER CHECKS PASSED` : `${fails} CHECK(S) FAILED (${passes} passed)`);
process.exit(fails === 0 ? 0 : 1);
