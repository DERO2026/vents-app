// Production smoke check of getvents.com as a GUEST on a phone viewport.
// Read-only: loads public pages only, never signs in, never submits anything.
// Prints one PASS/FAIL/INFO line per check and exits 1 on any FAIL.
// Run by .github/workflows/prod-smoke.yml (Actions -> Production smoke check).
import { chromium, devices } from 'playwright';

const BASE = process.env.SMOKE_BASE_URL || 'https://getvents.com';
const lines = []; let failed = false;
const out = (kind, msg) => { lines.push(`${kind}: ${msg}`); if (kind === 'FAIL') failed = true; };

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(m.text()));
const rows = [];
page.on('response', async (r) => {
  if (/\/rest\/v1\/events/.test(r.url()) && r.request().method() === 'GET') {
    try { const j = await r.json(); if (Array.isArray(j)) rows.push(...j); } catch {}
  }
});
// A flat dark band: an absolutely positioned layer over an image with a solid
// dark background (alpha >= 0.5), at least 20% of the image's height, no gradient.
const flatBands = () => page.evaluate(() => {
  let n = 0;
  for (const img of document.querySelectorAll('img')) {
    const ib = img.getBoundingClientRect(); if (ib.width < 120 || ib.height < 120 || !img.parentElement) continue;
    for (const el of img.parentElement.querySelectorAll('*')) {
      const cs = getComputedStyle(el); if (el === img || cs.position !== 'absolute') continue;
      const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/); if (!m) continue;
      const [r, g, b, a = 1] = m[1].split(',').map(Number); const bb = el.getBoundingClientRect();
      if (a >= 0.5 && r < 60 && g < 60 && b < 60 && bb.height >= ib.height * 0.2 && bb.width >= ib.width * 0.8 && cs.backgroundImage === 'none') n++;
    }
  }
  return n;
});

await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(4000);
out('INFO', `bundle ${await page.evaluate(() => document.querySelector('script[type=module]')?.getAttribute('src'))}`);
const guest = page.getByText('Browse as guest').first();
if (await guest.count()) { await guest.click(); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(5000); }
const featured = await page.locator('[data-testid="featured-scrim"]').count();
const homeBands = await flatBands();
out(homeBands === 0 ? 'PASS' : 'FAIL', `home/Featured: ${homeBands} flat dark band(s) over flyers (Featured cards with the gradient: ${featured})`);

const ev = rows.find((e) => e.image_url && !e.deleted_at && (e.location_type || 'in_person') !== 'online');
if (!ev) out('INFO', 'no in-person event with a flyer was listed; event details not checked');
else {
  await page.goto(`${BASE}/?event=${ev.id}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(6000);
  const scrim = await page.locator('[data-testid="event-hero-scrim"]').count();
  const bands = await flatBands();
  out(bands === 0 && scrim > 0 ? 'PASS' : 'FAIL', `event details: ${bands} flat dark band(s), gradient present: ${scrim > 0}`);
  const mapEl = page.getByText(/Map unavailable|Get Directions/).first();
  if (await mapEl.count()) { await mapEl.scrollIntoViewIfNeeded(); await page.waitForTimeout(8000); }
  const m = await page.evaluate(() => ({
    googleError: !!document.querySelector('.gm-err-container, .gm-err-message') || /can.t load Google Maps correctly/i.test(document.body.innerText),
    fallback: /Map unavailable/.test(document.body.innerText),
    tiles: !!document.querySelector('.gm-style'),
  }));
  out(m.googleError ? 'FAIL' : 'PASS', `event map: Google's error box shown: ${m.googleError}`);
  const billing = consoleMsgs.find((t) => /BillingNotEnabledMapError|ApiNotActivatedMapError|RefererNotAllowedMapError|InvalidKeyMapError|ApiTargetBlockedMapError/.test(t));
  if (m.tiles && !m.fallback) out('PASS', 'event map: Google Maps loaded (live map)');
  else out('INFO', `event map: fallback shown (${m.fallback}); Google says: ${billing ? billing.match(/\w+MapError/)[0] : 'no error reported'}`);
}
for (const l of lines) console.log(l);
await browser.close();
process.exit(failed ? 1 : 0);
