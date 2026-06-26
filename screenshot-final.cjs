// Final screenshot pass — fix remaining items
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const EMAIL = 'djjackson361@gmail.com';
const PASSWORD = 'Dero2026$';
const ROOT_EMAIL = 'ventsappltd@gmail.com';
const ROOT_PASS = 'Vents2024!';
const OUT = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

// Fill React-controlled inputs reliably
async function fillInput(page, selector, value) {
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value);
}

async function fillAll(page, email, pass) {
  return page.evaluate((e, p) => {
    const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    function fill(el, v) { if (!el) return false; niv.call(el, v); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; }
    return {
      email: fill(document.querySelector('input[type="text"]') || document.querySelector('input[placeholder*="Email"]'), e),
      pass: fill(document.querySelector('input[type="password"]'), p),
    };
  }, email, pass);
}

async function login(page, email, pass) {
  const body = await page.evaluate(() => document.body.innerText.toLowerCase());
  if (body.includes('get started') || body.includes('discover nigeria')) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim() === 'Sign in' && !e.children.length);
      if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 1500));
  }
  const body2 = await page.evaluate(() => document.body.innerText);
  if (!body2.includes('Welcome back') && !body2.includes('Email')) { console.log('Unexpected state:', body2.slice(0,60)); return false; }
  await fillAll(page, email, pass);
  await new Promise(r => setTimeout(r, 300));
  const btnRect = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sign In');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  });
  if (btnRect) await page.mouse.click(btnRect.x, btnRect.y);
  await new Promise(r => setTimeout(r, 6000));
  const loggedIn = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some(b => b.textContent.includes('Home')) &&
    [...document.querySelectorAll('button')].some(b => b.textContent.includes('Profile'))
  );
  console.log('Login:', email, loggedIn ? '✓' : '✗');
  return loggedIn;
}

async function ss(page, name) {
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`✓ ${name}.png`);
}

// Use React fiber to directly call onClick prop on element containing text
async function fiberClick(page, text) {
  return page.evaluate((t) => {
    const span = [...document.querySelectorAll('span, div, button, a')].find(e =>
      e.textContent.trim() === t && !e.children.length
    );
    if (!span) { console.log('Element not found for fiber click:', t); return false; }
    // Walk up DOM looking for React onClick prop
    let el = span;
    let depth = 0;
    while (el && depth < 10) {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactProps'));
      if (fk) {
        // Try __reactProps first (React 18 stores props directly)
        const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
        if (propsKey && el[propsKey]?.onClick) {
          el[propsKey].onClick({ preventDefault: () => {}, stopPropagation: () => {} });
          console.log('Called onClick via __reactProps on', el.tagName, 'text:', el.textContent.trim().slice(0,20));
          return true;
        }
        // Try fiber memoizedProps
        const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber'));
        if (fiberKey) {
          const fiber = el[fiberKey];
          if (fiber?.memoizedProps?.onClick) {
            fiber.memoizedProps.onClick({ preventDefault: () => {}, stopPropagation: () => {} });
            console.log('Called onClick via fiber on', el.tagName);
            return true;
          }
        }
      }
      el = el.parentElement;
      depth++;
    }
    // Last resort: native click
    span.click();
    return 'native-click';
  }, text);
}

async function goTo(page, tab) {
  await page.evaluate((t) => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(b => b.textContent.includes(t));
    if (b) b.click();
  }, tab);
  await new Promise(r => setTimeout(r, 800));
}

async function scrollEl(page, px) {
  await page.evaluate((p) => {
    // Find the visible scrollable container
    const candidates = [...document.querySelectorAll('*')].filter(e => {
      const s = window.getComputedStyle(e);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight;
    });
    if (candidates.length > 0) {
      // Sort by scroll height descending to find main content
      candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
      candidates[0].scrollTop += p;
    }
    window.scrollBy(0, p);
  }, px);
  await new Promise(r => setTimeout(r, 500));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 390, height: 844 },
    args: ['--window-size=430,900', '--no-sandbox', '--disable-infobars'],
    userDataDir: 'C:\\Temp\\puppeteer-vents-final',
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto('https://getvents.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => document.body.innerText.length > 100,
      { timeout: 30000 }
    );
    await new Promise(r => setTimeout(r, 2500));

    await login(page, EMAIL, PASSWORD);

    // === ITEM 3: Help Center ===
    console.log('\n--- Item 3: Help Center via fiber click ---');
    await goTo(page, 'Profile');
    // Navigate to Settings via gear icon
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Change profile photo"]');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1000));
    // Scroll to SUPPORT & LEGAL section
    await scrollEl(page, 400);
    await new Promise(r => setTimeout(r, 500));
    await scrollEl(page, 200);
    await new Promise(r => setTimeout(r, 500));
    await ss(page, 'f-01-settings-support');

    // Try fiber click on Help Center
    const hcResult = await fiberClick(page, 'Help Center');
    console.log('Help Center fiber click:', hcResult);
    await new Promise(r => setTimeout(r, 1500));
    const hcBody = await page.evaluate(() => document.body.innerText);
    console.log('After HC click:', hcBody.slice(0, 80).replace(/\n/g,' '));
    if (hcBody.includes('Help') && (hcBody.includes('WhatsApp') || hcBody.includes('FAQ') || hcBody.includes('Contact') || hcBody.includes('9030737368'))) {
      console.log('Help Center: ✓');
      console.log('WhatsApp:', hcBody.includes('9030737368') ? '✓' : '✗');
      console.log('Email:', hcBody.includes('ventsappltd') ? '✓' : '✗');
      await ss(page, 'f-03-help-center');
      await scrollEl(page, 300);
      await ss(page, 'f-03-help-center-faqs');
    } else {
      console.log('Help Center NOT reached — trying alternate approach');
      // Go back to settings and try clicking via parent div
      await page.evaluate(() => window.history.back && window.history.back());
      await new Promise(r => setTimeout(r, 600));
      await goTo(page, 'Profile');
      await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label="Change profile photo"]');
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 800));
      await scrollEl(page, 600);
      // Find div that contains "Help Center" span and click the PARENT div (SettingRow)
      const parentClicked = await page.evaluate(() => {
        const spans = [...document.querySelectorAll('span')];
        const hcSpan = spans.find(s => s.textContent.trim() === 'Help Center');
        if (!hcSpan) return 'span not found';
        // Go up to the div with onClick
        let el = hcSpan;
        for (let i = 0; i < 5; i++) {
          el = el.parentElement;
          if (!el) break;
          // Check for __reactProps onClick
          const pk = Object.keys(el).find(k => k.startsWith('__reactProps'));
          if (pk && el[pk]?.onClick) {
            el[pk].onClick({});
            return 'reactProps clicked on ' + el.tagName;
          }
        }
        // If no reactProps, check the span itself
        const pk2 = Object.keys(hcSpan).find(k => k.startsWith('__reactProps'));
        return pk2 ? JSON.stringify(Object.keys(hcSpan[pk2])) : 'no reactProps found';
      });
      console.log('Parent click result:', parentClicked);
      await new Promise(r => setTimeout(r, 1500));
      await ss(page, 'f-03-help-center-alt');
      const hcBody2 = await page.evaluate(() => document.body.innerText);
      console.log('Alt HC result:', hcBody2.slice(0,80).replace(/\n/g,' '));
      console.log('WhatsApp:', hcBody2.includes('9030737368') ? '✓' : '✗');
    }

    // === ITEM 12: My Tickets ===
    console.log('\n--- Item 12: My Tickets ---');
    await goTo(page, 'Profile');
    await new Promise(r => setTimeout(r, 500));
    // Check dero's role — might be organizer which hides My Tickets
    const profileBody = await page.evaluate(() => document.body.innerText);
    console.log('Profile shows My Tickets?', profileBody.includes('My Tickets'));
    // Find and click My Tickets via fiber
    if (profileBody.includes('My Tickets')) {
      await fiberClick(page, 'My Tickets');
    } else {
      // Scroll profile menu
      await scrollEl(page, 200);
      const body2 = await page.evaluate(() => document.body.innerText);
      console.log('After scroll, My Tickets?', body2.includes('My Tickets'));
      if (body2.includes('My Tickets')) {
        await fiberClick(page, 'My Tickets');
      } else {
        // Try clicking the Tickets tab in bottom nav (shows user's tickets)
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const tickets = btns.find(b => b.textContent.includes('Tickets'));
          if (tickets) tickets.click();
        });
      }
    }
    await new Promise(r => setTimeout(r, 1200));
    await ss(page, 'f-12-my-tickets');
    const ticketsBody = await page.evaluate(() => document.body.innerText);
    console.log('My Tickets body:', ticketsBody.slice(0,100).replace(/\n/g,' '));
    console.log('Back button:', await page.evaluate(() =>
      [...document.querySelectorAll('button')].some(b => !b.textContent.trim() && b.querySelector('svg'))
    ) ? '✓' : '✗');

    // === ITEM 7: Event detail + back ===
    console.log('\n--- Item 7: Event detail navigation ---');
    await goTo(page, 'Home');
    await new Promise(r => setTimeout(r, 800));
    // Click first event card by finding event content
    const clicked = await page.evaluate(() => {
      // Look for event cards by their price or date text
      const all = [...document.querySelectorAll('*')];
      const card = all.find(e =>
        e.innerText && e.innerText.includes('₦') &&
        e.tagName !== 'BUTTON' && e.tagName !== 'SPAN' &&
        window.getComputedStyle(e).cursor === 'pointer'
      );
      if (card) { card.click(); return card.tagName + ':' + card.innerText.slice(0,30); }
      // Fallback: click anything with a price
      const priceEl = all.find(e => e.innerText?.trim().startsWith('₦') && !e.children.length);
      if (priceEl) { priceEl.parentElement?.click(); return 'price parent'; }
      return null;
    });
    console.log('Event card click:', clicked);
    await new Promise(r => setTimeout(r, 1500));
    await ss(page, 'f-07-event-detail');
    const eventBody = await page.evaluate(() => document.body.innerText);
    console.log('Event detail:', eventBody.slice(0,80).replace(/\n/g,' '));
    // Click back
    const backClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const back = btns.find(b => !b.textContent.trim() && b.querySelector('svg'));
      if (back) { back.click(); return true; }
      // Try clicking first button (usually back arrow)
      if (btns[0]) { btns[0].click(); return 'first'; }
      return false;
    });
    console.log('Back clicked:', backClicked);
    await new Promise(r => setTimeout(r, 800));
    await ss(page, 'f-07-after-back');

    // === ITEM 5: Report button ===
    console.log('\n--- Item 5: Report button ---');
    // Click an event
    await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      const card = all.find(e =>
        e.innerText && e.innerText.includes('₦') &&
        e.tagName !== 'BUTTON' && window.getComputedStyle(e).cursor === 'pointer'
      );
      if (card) card.click();
    });
    await new Promise(r => setTimeout(r, 1500));
    // Find 3-dot / more options button (not the back button)
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      // Look for button with ellipsis text or "more" aria-label
      const more = btns.find(b =>
        b.textContent.includes('⋯') || b.textContent.includes('...') ||
        b.getAttribute('aria-label')?.toLowerCase().includes('more') ||
        b.getAttribute('aria-label')?.toLowerCase().includes('option')
      );
      if (more) { more.click(); return; }
      // Look for SVG buttons in the header area (top-right)
      const svgBtns = btns.filter(b => !b.textContent.trim() && b.querySelector('svg'));
      // Skip first (usually back), try last
      if (svgBtns.length > 1) svgBtns[svgBtns.length - 1].click();
    });
    await new Promise(r => setTimeout(r, 800));
    await ss(page, 'f-05-event-menu');
    // Try fiber click on Report
    const reportClicked = await fiberClick(page, 'Report');
    console.log('Report click:', reportClicked);
    await new Promise(r => setTimeout(r, 800));
    await ss(page, 'f-05-report-modal');
    const reportBody = await page.evaluate(() => document.body.innerText);
    console.log('Report modal:', reportBody.includes('Report') ? '✓' : '✗', reportBody.slice(0,80).replace(/\n/g,' '));

    // Submit the report
    if (reportBody.includes('spam') || reportBody.includes('Spam') || reportBody.includes('reason')) {
      // Select first reason
      await page.evaluate(() => {
        const all = [...document.querySelectorAll('*')];
        const reasonEl = all.find(e => (e.textContent.includes('spam') || e.textContent.includes('Spam') || e.textContent.includes('Misleading')) && !e.children.length);
        if (reasonEl) reasonEl.click();
      });
      await new Promise(r => setTimeout(r, 500));
      // Click Submit
      await fiberClick(page, 'Submit Report');
      await new Promise(r => setTimeout(r, 1000));
      await ss(page, 'f-05-report-submitted');
      const submitBody = await page.evaluate(() => document.body.innerText);
      console.log('Report submitted:', submitBody.includes('success') || submitBody.includes('Thank') || submitBody.includes('submitted') ? '✓' : '?', submitBody.slice(0,80).replace(/\n/g,' '));
    }

    // === ITEM 9: Admin Dashboard — Sign out, login as admin ===
    console.log('\n--- Item 9: Admin (sign out + admin login) ---');
    // Sign out using fiber click on Sign Out
    await goTo(page, 'Profile');
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Change profile photo"]');
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1000));
    // Scroll to Sign Out
    await scrollEl(page, 400);
    await scrollEl(page, 400);
    await new Promise(r => setTimeout(r, 500));
    const signOutResult = await fiberClick(page, 'Sign Out');
    console.log('Sign Out:', signOutResult);
    await new Promise(r => setTimeout(r, 2000));
    // Confirm sign out dialog
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const confirm = btns.find(b => b.textContent.includes('Sign Out') || b.textContent.trim() === 'Yes');
      if (confirm) confirm.click();
    });
    await new Promise(r => setTimeout(r, 2000));
    await ss(page, 'f-09-signed-out');

    // Login as admin
    const adminLoggedIn = await login(page, ROOT_EMAIL, ROOT_PASS);
    if (adminLoggedIn) {
      await ss(page, 'f-09-admin-home');
      // Click Admin in profile menu
      await goTo(page, 'Profile');
      await new Promise(r => setTimeout(r, 500));
      const adminClickResult = await fiberClick(page, 'Admin Console');
      console.log('Admin Console click:', adminClickResult);
      await new Promise(r => setTimeout(r, 1200));
      await ss(page, 'f-09-admin-dashboard');
      const adminBody = await page.evaluate(() => document.body.innerText);
      console.log('Admin screen:', adminBody.slice(0,120).replace(/\n/g,' '));
      console.log('Revenue:', adminBody.includes('Revenue') || adminBody.includes('₦') ? '✓' : '✗');
      console.log('New This Week:', adminBody.includes('Week') ? '✓' : '✗');
      await scrollEl(page, 300);
      await ss(page, 'f-09-admin-stats');

      // Check reports tab (Item 5 DB evidence)
      const reportsTab = await fiberClick(page, 'Reports');
      if (!reportsTab) {
        await fiberClick(page, 'Reports');
      }
      await new Promise(r => setTimeout(r, 800));
      await ss(page, 'f-09-admin-reports');
    }

    // === ITEM 8: Vents Cents ===
    console.log('\n--- Item 8: Vents Cents (DB evidence) ---');
    // Show wallet screen — go to profile and check wallet/VC balance
    if (adminLoggedIn) {
      await goTo(page, 'Home');
    }

    console.log('\n=== Final screenshots saved ===');
    fs.readdirSync(OUT).filter(f => f.startsWith('f-')).sort().forEach(f => console.log(' -', f));

  } finally {
    await browser.close();
  }
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
