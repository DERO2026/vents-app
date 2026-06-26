// Targeted screenshot run for remaining items
// Uses v4 profile (confirmed working login session)
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const EMAIL = 'djjackson361@gmail.com';
const PASSWORD = 'Dero2026$';
const ROOT_EMAIL = 'ventsappltd@gmail.com';
const ROOT_PASS = 'Vents2024!';
const OUT = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

async function fillInputs(page, email, pass) {
  return page.evaluate((e, p) => {
    const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const fill = (el, v) => { if (!el) return false; niv.call(el, v); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; };
    return {
      email: fill(document.querySelector('input[type="text"]'), e),
      pass: fill(document.querySelector('input[type="password"]'), p),
    };
  }, email, pass);
}

async function doLogin(page, email, pass) {
  // Check current state
  const bodyText = await page.evaluate(() => document.body.innerText);
  const bodyLow = bodyText.toLowerCase();

  // Already logged in?
  const hasNav = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.some(b => b.textContent === 'Home') || btns.some(b => b.textContent === 'Explore');
  });
  if (hasNav) { console.log('Already logged in ✓'); return true; }

  // On splash? Click sign in
  if (bodyLow.includes('get started') || bodyLow.includes('discover nigeria')) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim() === 'Sign in' && !e.children.length);
      if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 2000));
  }

  // Fill and submit
  await fillInputs(page, email, pass);
  await new Promise(r => setTimeout(r, 500));
  const btnRect = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign In');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  });
  if (btnRect) await page.mouse.click(btnRect.x, btnRect.y);
  await new Promise(r => setTimeout(r, 7000));

  const hasNavAfter = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.some(b => b.textContent === 'Home');
  });
  console.log('Login:', email, hasNavAfter ? '✓' : '✗');
  return hasNavAfter;
}

async function ss(page, name) {
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`✓ ${name}.png`);
}

async function goTab(page, name) {
  await page.evaluate((n) => {
    [...document.querySelectorAll('button')].find(b => b.textContent === n)?.click();
  }, name);
  await new Promise(r => setTimeout(r, 800));
}

async function scrollContent(page, px) {
  await page.evaluate((p) => {
    // Find the tallest scrollable element
    const els = [...document.querySelectorAll('*')].filter(e => {
      const cs = window.getComputedStyle(e);
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 10;
    }).sort((a, b) => b.scrollHeight - a.scrollHeight);
    if (els[0]) els[0].scrollTop += p;
    else window.scrollBy(0, p);
  }, px);
  await new Promise(r => setTimeout(r, 400));
}

// Call onClick via __reactProps on the element or its ancestors
async function triggerReactClick(page, textContent) {
  return page.evaluate((text) => {
    // Find span/button with exact text
    const target = [...document.querySelectorAll('*')].find(e =>
      e.textContent.trim() === text && !e.children.length
    );
    if (!target) return `not-found: ${text}`;

    // Try __reactProps on element and ancestors
    let el = target;
    for (let i = 0; i < 8; i++) {
      if (!el) break;
      const pk = Object.keys(el).find(k => k.startsWith('__reactProps'));
      if (pk) {
        const props = el[pk];
        if (props?.onClick) {
          props.onClick({ type: 'click', preventDefault: ()=>{}, stopPropagation: ()=>{} });
          return `clicked-reactProps on ${el.tagName}[${i}]`;
        }
      }
      el = el.parentElement;
    }
    // Native click as fallback
    target.click();
    return 'native-click';
  }, textContent);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 390, height: 844 },
    args: ['--window-size=430,900', '--no-sandbox', '--disable-infobars'],
    userDataDir: 'C:\\Temp\\puppeteer-vents-v4', // v4 has working session
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto('https://getvents.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for app to render past splash
    await page.waitForFunction(
      () => document.querySelectorAll('button').length > 2,
      { timeout: 30000 }
    );
    await new Promise(r => setTimeout(r, 3000));

    const ok = await doLogin(page, EMAIL, PASSWORD);
    if (!ok) { console.log('Login failed'); await ss(page, 'login-fail'); return; }

    await ss(page, 'home-confirmed');

    // === HELP CENTER ===
    console.log('\n--- Help Center ---');
    await goTab(page, 'Profile');
    // Click the gear/settings button
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Change profile photo"]');
      if (btn) { btn.click(); return; }
      // Fallback: find Settings in profile menu
      const btns = [...document.querySelectorAll('button')];
      const s = btns.find(b => b.textContent.includes('Settings') && b.textContent.includes('Account'));
      if (s) s.click();
    });
    await new Promise(r => setTimeout(r, 1200));
    const onSettings = await page.evaluate(() => document.body.innerText.includes('ACCOUNT') || document.body.innerText.includes('Settings'));
    console.log('On Settings:', onSettings);

    if (onSettings) {
      // Scroll to find Help Center
      await scrollContent(page, 400);
      await new Promise(r => setTimeout(r, 400));
      const hcVisible = await page.evaluate(() =>
        [...document.querySelectorAll('span')].some(s => s.textContent.trim() === 'Help Center')
      );
      console.log('Help Center span visible:', hcVisible);
      if (!hcVisible) {
        await scrollContent(page, 300);
        await new Promise(r => setTimeout(r, 400));
      }
      await ss(page, 'settings-with-hc');
      const hcResult = await triggerReactClick(page, 'Help Center');
      console.log('Help Center click:', hcResult);
      await new Promise(r => setTimeout(r, 2000));
      const body = await page.evaluate(() => document.body.innerText);
      console.log('After HC click:', body.slice(0, 100).replace(/\n/g,' '));
      if (body.includes('WhatsApp') || body.includes('9030737368') || body.includes('Frequently') || body.toLowerCase().includes('faq')) {
        await ss(page, 'help-center-content');
        await scrollContent(page, 300);
        await ss(page, 'help-center-faqs');
        console.log('WhatsApp:', body.includes('9030737368') ? '✓' : '✗');
        console.log('Email:', body.includes('ventsappltd') ? '✓' : '✗');
      } else {
        await ss(page, 'help-center-fail');
        console.log('HC not reached. Checking if we navigated:', body.slice(0,60));
      }
    } else {
      console.log('Not on Settings!');
      await ss(page, 'not-settings');
    }

    // === MY TICKETS ===
    console.log('\n--- My Tickets ---');
    await goTab(page, 'Tickets');
    await new Promise(r => setTimeout(r, 1000));
    await ss(page, 'my-tickets-tab');
    const ticketsBody = await page.evaluate(() => document.body.innerText);
    console.log('Tickets screen:', ticketsBody.slice(0,80).replace(/\n/g,' '));

    // === EVENT DETAIL + REPORT ===
    console.log('\n--- Event Detail + Report ---');
    await goTab(page, 'Home');
    await new Promise(r => setTimeout(r, 800));
    // Click first event card
    const cardClicked = await page.evaluate(() => {
      // Find event cards (divs with price text ₦ and cursor pointer)
      const priceEls = [...document.querySelectorAll('*')].filter(e =>
        e.textContent.trim().startsWith('₦') && !e.children.length
      );
      if (priceEls.length > 0) {
        // Click the grandparent (event card)
        const card = priceEls[0].closest('[style*="cursor: pointer"], [style*="cursor:pointer"]') ||
                     priceEls[0].parentElement?.parentElement;
        if (card) { card.click(); return 'price-based:' + priceEls[0].textContent; }
      }
      // Fallback: click img parent
      const imgs = [...document.querySelectorAll('img')];
      const img = imgs.find(i => i.style?.objectFit === 'cover' || i.className?.includes('cover'));
      if (img) { img.parentElement?.click(); return 'img-based'; }
      return null;
    });
    console.log('Card clicked:', cardClicked);
    await new Promise(r => setTimeout(r, 1500));
    const eventBody = await page.evaluate(() => document.body.innerText);
    console.log('Event screen:', eventBody.slice(0,80).replace(/\n/g,' '));
    await ss(page, 'event-detail');

    // Find 3-dot menu in event detail header
    const moreMenuClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      // Skip back button (index 0), look for others
      const candidates = btns.slice(1);
      // Find button with SVG or with ⋯/⋮
      const moreBtn = candidates.find(b =>
        b.textContent.includes('⋯') || b.textContent.includes('⋮') || b.textContent.includes('...') ||
        (b.querySelector('svg') && !b.textContent.trim()) ||
        b.getAttribute('aria-label')?.toLowerCase().includes('more')
      );
      if (!moreBtn) {
        // Just try the last button
        const last = btns[btns.length - 1];
        if (last && last !== btns[0]) { last.click(); return 'last-button'; }
        return null;
      }
      const r = moreBtn.getBoundingClientRect();
      moreBtn.click();
      return `more-btn at ${r.left},${r.top}`;
    });
    console.log('More menu:', moreMenuClicked);
    await new Promise(r => setTimeout(r, 800));
    await ss(page, 'event-more-menu');

    // Try clicking Report
    const reportResult = await triggerReactClick(page, 'Report');
    if (!reportResult.includes('not-found')) {
      await new Promise(r => setTimeout(r, 800));
      await ss(page, 'report-modal');
      const reportBody = await page.evaluate(() => document.body.innerText);
      console.log('Report modal:', reportBody.slice(0,80).replace(/\n/g,' '));

      // Submit a report
      const reasonClicked = await page.evaluate(() => {
        const all = [...document.querySelectorAll('*')];
        const reasons = ['Spam', 'Misleading', 'Inappropriate', 'Scam', 'spam'];
        for (const r of reasons) {
          const el = all.find(e => e.textContent.trim() === r && !e.children.length);
          if (el) { el.click(); return r; }
        }
        // Click first radio/option
        const radios = [...document.querySelectorAll('input[type="radio"]')];
        if (radios[0]) { radios[0].click(); return 'radio-0'; }
        return null;
      });
      console.log('Reason clicked:', reasonClicked);
      await new Promise(r => setTimeout(r, 400));
      const submitResult = await triggerReactClick(page, 'Submit Report');
      console.log('Submit:', submitResult);
      await new Promise(r => setTimeout(r, 1500));
      await ss(page, 'report-submitted');
    } else {
      console.log('Report not found. Current screen:', (await page.evaluate(() => document.body.innerText)).slice(0,100));
      await ss(page, 'no-report');
    }

    // === ADMIN DASHBOARD ===
    console.log('\n--- Admin Dashboard ---');
    // Sign out current user via Settings
    await goTab(page, 'Profile');
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Change profile photo"]');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1000));
    // Scroll to Sign Out
    for (let i = 0; i < 6; i++) await scrollContent(page, 200);
    await new Promise(r => setTimeout(r, 500));
    await ss(page, 'settings-scroll-signout');
    const signOutResult = await triggerReactClick(page, 'Sign Out');
    console.log('Sign Out:', signOutResult);
    await new Promise(r => setTimeout(r, 1000));
    // Confirm dialog if present
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const confirm = btns.find(b => b.textContent.trim() === 'Sign Out' || b.textContent.trim() === 'Confirm' || b.textContent.trim() === 'Yes');
      if (confirm) confirm.click();
    });
    await new Promise(r => setTimeout(r, 3000));
    await ss(page, 'after-signout');

    // Login as admin
    const adminOk = await doLogin(page, ROOT_EMAIL, ROOT_PASS);
    console.log('Admin login:', adminOk ? '✓' : '✗');
    if (adminOk) {
      await ss(page, 'admin-logged-in');
      // Navigate to Admin Console from Profile
      await goTab(page, 'Profile');
      await new Promise(r => setTimeout(r, 500));
      const adminResult = await triggerReactClick(page, 'Admin Console');
      console.log('Admin Console click:', adminResult);
      if (adminResult.includes('not-found')) {
        // Try scrolling profile
        await scrollContent(page, 300);
        const r2 = await triggerReactClick(page, 'Admin Console');
        console.log('Admin Console retry:', r2);
      }
      await new Promise(r => setTimeout(r, 1500));
      await ss(page, 'admin-dashboard');
      const adminBody = await page.evaluate(() => document.body.innerText);
      console.log('Admin body:', adminBody.slice(0,120).replace(/\n/g,' '));
      console.log('Revenue:', adminBody.includes('Revenue') ? '✓' : '✗');
      console.log('New This Week:', adminBody.includes('Week') || adminBody.includes('New This') ? '✓' : '✗');
      await scrollContent(page, 300);
      await ss(page, 'admin-stats');
    }

    console.log('\n=== Done ===');
    const newFiles = fs.readdirSync(OUT).filter(f => !f.startsWith('0') && !f.startsWith('f-') && !f.startsWith('1') && !f.startsWith('debug') && f.endsWith('.png')).sort();
    newFiles.forEach(f => console.log(' -', f));

  } finally {
    await browser.close();
  }
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
