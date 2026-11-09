// Production visual check of getvents.com on a mobile viewport. Read-only:
// it only loads public pages as a guest. Results are encrypted to
// recipient.crt before they are committed (public repository).
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const OUT = 'out';
fs.mkdirSync(OUT, { recursive: true });
const R = { checkedAt: new Date().toISOString() };
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
const rows = [];
page.on('response', async (r) => {
  if (/\/rest\/v1\/events/.test(r.url()) && r.request().method() === 'GET') {
    try { const j = await r.json(); if (Array.isArray(j)) rows.push(...j); } catch {}
  }
});

// Any absolutely positioned layer over an image that is a FLAT dark band
// (solid background colour with alpha >= 0.5, no gradient) and >= 20% of
// the image's height. This is exactly the bug; the intended scrim is a
// gradient (background-image), so it never matches.
const findBands = () => page.evaluate(() => {
  const out = [];
  for (const img of document.querySelectorAll('img')) {
    const ib = img.getBoundingClientRect();
    if (ib.width < 120 || ib.height < 120) continue;
    const parent = img.parentElement; if (!parent) continue;
    for (const el of parent.querySelectorAll('*')) {
      if (el === img) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'absolute') continue;
      const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/); if (!m) continue;
      const [r, g, b, a = 1] = m[1].split(',').map(Number);
      const b2 = el.getBoundingClientRect();
      if (a >= 0.5 && r < 60 && g < 60 && b < 60 && b2.height >= ib.height * 0.2 && b2.width >= ib.width * 0.8 && cs.backgroundImage === 'none') {
        out.push({ bg: cs.backgroundColor, h: Math.round(b2.height), imgH: Math.round(ib.height) });
      }
    }
  }
  return out;
});
const scrimInfo = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].slice(0, 3).map((el) => {
  const cs = getComputedStyle(el); const p = el.parentElement.getBoundingClientRect(); const b = el.getBoundingClientRect();
  return { backgroundImage: cs.backgroundImage, backgroundColor: cs.backgroundColor, heightPctOfParent: Math.round((b.height / p.height) * 100), bottomAligned: Math.abs(b.bottom - p.bottom) < 2 };
}), sel);

// 1. Home + Featured
await page.goto('https://getvents.com/', { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(5000);
R.mainScript = await page.evaluate(() => document.querySelector('script[type=module]')?.getAttribute('src'));
await page.screenshot({ path: `${OUT}/01-home.png` });
R.featured = { count: await page.locator('[data-testid="featured-scrim"]').count(), scrims: await scrimInfo('[data-testid="featured-scrim"]'), flatBands: await findBands() };
if (R.featured.count) {
  const card = page.locator('[data-testid="featured-scrim"]').first().locator('xpath=..');
  await card.scrollIntoViewIfNeeded(); await page.waitForTimeout(800);
  await card.screenshot({ path: `${OUT}/02-featured-card.png` });
}

// 2. Event details (an in-person event with a flyer, via the public deep link)
const pick = rows.find((e) => e.image_url && !e.deleted_at && (e.location_type || 'in_person') !== 'online')
  || rows.find((e) => e.image_url && !e.deleted_at);
R.eventPicked = pick ? { id: pick.id, hasCoords: pick.latitude != null && pick.longitude != null } : null;
if (pick) {
  await page.goto(`https://getvents.com/?event=${pick.id}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/03-event-details-top.png` });
  R.eventDetails = { scrims: await scrimInfo('[data-testid="event-hero-scrim"]'), flatBands: await findBands() };
  // 3. The venue map on event details
  const mapText = page.getByText(/Map unavailable|Get Directions/).first();
  if (await mapText.count()) { await mapText.scrollIntoViewIfNeeded(); await page.waitForTimeout(6000); }
  await page.screenshot({ path: `${OUT}/04-event-details-map.png` });
  R.map = await page.evaluate(() => ({
    googleErrorBox: !!document.querySelector('.gm-err-container, .gm-err-message'),
    googleErrorText: /can.t load Google Maps correctly/i.test(document.body.innerText),
    fallbackShown: /Map unavailable/.test(document.body.innerText),
    liveMapTiles: !!document.querySelector('.gm-style'),
  }));
}

// 4. Every JS chunk production serves: old flat bands gone, new scrim present
const html = await (await fetch('https://getvents.com/')).text();
const seen = new Set(); const queue = [...html.matchAll(/assets\/[\w.-]+\.js/g)].map((m) => m[0]);
const OLD = ['rgba(2,0,5,0.7)', 'rgba(7,3,15,0.85)', 'rgba(10,6,18,0.8)', 'rgba(19,22,41,0.7)', 'rgba(6,10,18,0.75)', 'rgba(2,0,5,0.75)', 'rgba(0,0,0,0.65)', 'rgba(0,0,0,0.75)'];
const hits = { newScrim: 0, gmErrWatcher: 0, mapFallback: 0, old: {} };
while (queue.length) {
  const p = queue.shift(); if (seen.has(p)) continue; seen.add(p);
  const t = await (await fetch(`https://getvents.com/${p}`)).text();
  for (const m of t.matchAll(/assets\/[\w.-]+\.js/g)) if (!seen.has(m[0])) queue.push(m[0]);
  for (const m of t.matchAll(/["'`](?:\.\/|\/)?([\w.-]+-[\w-]{8}\.js)["'`]/g)) { const q = `assets/${m[1]}`; if (!seen.has(q)) queue.push(q); }
  if (t.includes('rgba(6,10,20,0.88)')) hits.newScrim++;
  if (t.includes('gm-err-container')) hits.gmErrWatcher++;
  if (t.includes('Map unavailable')) hits.mapFallback++;
  for (const o of OLD) { const n = t.split(o).length - 1; if (n) hits.old[o] = (hits.old[o] || 0) + n; }
}
R.bundle = { chunksScanned: seen.size, ...hits };
const embed = await (await fetch('https://getvents.com/embed/map.html')).text();
R.iosEmbedHasWatcher = embed.includes('watchForGoogleErrorUi');
R.console = consoleMsgs.filter((m) => /google|maps|gm_/i.test(m)).slice(0, 20);
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(R, null, 2));
await browser.close();
