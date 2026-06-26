// Final screenshot pass - uses waitForFunction instead of fixed timeouts
// v4 profile has working session
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const DERO_EMAIL = 'djjackson361@gmail.com';
const DERO_PASS  = 'Dero2026$';
const ROOT_EMAIL = 'ventsappltd@gmail.com';
const ROOT_PASS  = 'Vents2024!';
const OUT = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const wait = ms => new Promise(r => setTimeout(r, ms));

async function ss(page, name) {
  await wait(2500); // generous wait for React re-render + animations
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}

async function waitForText(page, text, timeout = 10000) {
  try {
    await page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      { timeout },
      text
    );
    return true;
  } catch { return false; }
}

async function clickReact(page, label) {
  // Walk up DOM from text node, call onClick via __reactProps
  const result = await page.evaluate((lbl) => {
    const all = [...document.querySelectorAll('*')];
    // Find element with EXACTLY this text (no children)
    let el = all.find(e => !e.children.length && e.textContent.trim() === lbl);
    if (!el) {
      // Try partial match on leaf node
      el = all.find(e => !e.children.length && e.textContent.trim().includes(lbl));
    }
    if (!el) return `not-found:${lbl}`;
    let cur = el;
    for (let i = 0; i < 10; i++) {
      if (!cur) break;
      const pk = Object.keys(cur).find(k => k.startsWith('__reactProps$'));
      if (pk && cur[pk]?.onClick) {
        cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} });
        return `ok:${cur.tagName}[depth=${i}]`;
      }
      cur = cur.parentElement;
    }
    // native fallback
    el.click();
    return `native-click:${el.tagName}`;
  }, label);
  return result;
}

async function goTab(page, name) {
  await page.evaluate((n) => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === n);
    if (btn) btn.click();
  }, name);
  await wait(1500);
}

async function scrollEl(page, px) {
  await page.evaluate((p) => {
    const els = [...document.querySelectorAll('*')].filter(e => {
      const s = window.getComputedStyle(e);
      return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight > e.clientHeight + 10;
    }).sort((a,b) => b.scrollHeight - a.scrollHeight);
    if (els[0]) els[0].scrollTop += p; else window.scrollBy(0,p);
  }, px);
  await wait(500);
}

async function doLogin(page, email, pass) {
  // Check logged in
  const loggedIn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.some(b => ['Home','Explore','Profile'].includes(b.textContent.trim()));
  });
  if (loggedIn) { console.log('  Already logged in'); return true; }

  // Click "Sign in" on splash/welcome
  const body = await page.evaluate(() => document.body.innerText.toLowerCase());
  if (body.includes('get started') || body.includes('discover nigeria')) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Sign in' && !e.children.length);
      if (el) el.click();
    });
    await wait(2000);
  }

  // Fill inputs via native value setter
  await page.evaluate((e, p) => {
    const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const fill = (el, v) => { if (!el) return; niv.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
    fill(document.querySelector('input[type="text"]'), e);
    fill(document.querySelector('input[type="password"]'), p);
  }, email, pass);
  await wait(500);

  // Click Sign In button
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Sign In');
    if (btn) btn.click();
  });

  const ok = await waitForText(page, 'Home', 12000) || await waitForText(page, 'Explore', 8000);
  console.log(`  Login ${email}:`, ok ? '✓' : '✗');
  if (!ok) { await ss(page, 'login-fail-' + email.split('@')[0]); }
  return ok;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 390, height: 844 },
    args: ['--window-size=430,900','--no-sandbox','--disable-infobars'],
    userDataDir: 'C:\\Temp\\puppeteer-vents-v4',
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });

  try {
    console.log('\n=== Loading app ===');
    await page.goto('https://getvents.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('button').length > 0, { timeout: 30000 });
    await wait(3000);

    const deroOk = await doLogin(page, DERO_EMAIL, DERO_PASS);
    if (!deroOk) { console.log('Login failed'); await browser.close(); return; }
    await wait(2000);
    await ss(page, 'A-home-dero');

    // === ITEM 3: HELP CENTER via Profile menu ===
    console.log('\n=== Item 3: Help Center ===');
    await goTab(page, 'Profile');
    // Profile screen loads - look for "Help & Support" menu item
    const hcFromProfile = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find(b => b.textContent.includes('Help') && b.textContent.includes('Support'));
      if (btn) { btn.click(); return 'clicked-profile-menu'; }
      // Scroll down and look
      return 'not-found-in-profile';
    });
    console.log('  Profile Help click:', hcFromProfile);
    if (hcFromProfile === 'not-found-in-profile') {
      // Try scrolling profile menu
      await scrollEl(page, 300);
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const btn = btns.find(b => b.textContent.includes('Help') && b.textContent.includes('Support'));
        if (btn) btn.click();
      });
    }
    const onHC = await waitForText(page, 'WhatsApp', 5000) || await waitForText(page, 'Frequently', 5000) || await waitForText(page, 'FAQ', 5000);
    const hcBody = await page.evaluate(() => document.body.innerText);
    console.log('  HC reached:', onHC, '| body snippet:', hcBody.slice(0,80).replace(/\n/g,' '));
    await ss(page, 'B-help-center-top');
    if (onHC) {
      await scrollEl(page, 400);
      await ss(page, 'B-help-center-faqs');
    } else {
      // Fallback: try from Settings
      console.log('  HC not reached from Profile. Trying Settings...');
      // Go back first
      await page.evaluate(() => { const b = document.querySelector('button[aria-label="Go back"], button[aria-label="Back"]'); if(b) b.click(); });
      await wait(1000);
      // Try settings
      await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label="Change profile photo"]');
        if (btn) btn.click();
      });
      await wait(1500);
      // Scroll to help center in settings
      for (let i = 0; i < 5; i++) await scrollEl(page, 150);
      const visible = await page.evaluate(() =>
        [...document.querySelectorAll('*')].some(e => e.textContent.trim() === 'Help Center' && !e.children.length)
      );
      console.log('  Help Center in settings:', visible);
      if (visible) {
        await ss(page, 'B-settings-with-hc');
        const r = await clickReact(page, 'Help Center');
        console.log('  Clicked:', r);
        const ok2 = await waitForText(page, 'WhatsApp', 5000) || await waitForText(page, 'FAQ', 5000) || await waitForText(page, 'Frequently', 5000);
        console.log('  HC from settings:', ok2);
        await ss(page, 'B-help-center-settings');
        if (ok2) {
          await scrollEl(page, 400);
          await ss(page, 'B-help-center-faqs2');
        }
      }
    }

    // === ITEM 12: MY TICKETS (back button) ===
    console.log('\n=== Item 12: My Tickets ===');
    await goTab(page, 'Tickets');
    await waitForText(page, 'ticket', 5000);
    await ss(page, 'C-my-tickets');
    // Check for back button (chevron/arrow)
    const hasBack = await page.evaluate(() => {
      const backBtn = document.querySelector('button[aria-label="Go back"]') ||
                      document.querySelector('button[aria-label="Back"]') ||
                      [...document.querySelectorAll('button')].find(b => b.querySelector('svg') && b === document.querySelectorAll('button')[0]);
      return !!backBtn;
    });
    console.log('  Has back button:', hasBack);

    // === ITEM 7: 3-DEEP NAVIGATION ===
    console.log('\n=== Item 7: 3-deep navigation ===');
    await goTab(page, 'Home');
    await wait(1500);
    // Click an event card to go to event detail (depth 2)
    const cardClicked = await page.evaluate(() => {
      // Find event cards - look for divs with cursor pointer containing event-like content
      const cards = [...document.querySelectorAll('[style*="cursor: pointer"]')].filter(el =>
        el.offsetHeight > 100 && !el.closest('nav')
      );
      if (cards.length > 0) { cards[0].click(); return `card[${cards.length} found]`; }
      // Fallback: find any img with cover styling
      const imgs = [...document.querySelectorAll('img')];
      const img = imgs.find(i => i.getBoundingClientRect().height > 80);
      if (img) { (img.closest('[style*="cursor"]') || img.parentElement)?.click(); return 'img-parent'; }
      return null;
    });
    console.log('  Card click:', cardClicked);
    const onEvent = await waitForText(page, 'Get Tickets', 5000) || await waitForText(page, 'Interested', 5000) || await waitForText(page, 'organizer', 4000);
    console.log('  On event detail:', onEvent);
    await ss(page, 'D-event-detail-depth2');
    const eventBody = await page.evaluate(() => document.body.innerText);
    console.log('  Event body:', eventBody.slice(0,80).replace(/\n/g,' '));

    // From event detail, click organizer name to go 3 deep
    if (onEvent) {
      const orgClicked = await page.evaluate(() => {
        // Find organizer/host link
        const spans = [...document.querySelectorAll('*')].filter(e =>
          !e.children.length && (e.textContent.trim().match(/by |hosted|organizer/i))
        );
        for (const s of spans) {
          const pk = Object.keys(s.parentElement || {}).find(k => k.startsWith('__reactProps$'));
          if (pk && s.parentElement[pk]?.onClick) {
            s.parentElement[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} });
            return 'org-link-clicked';
          }
        }
        // Try clicking organizer avatar area
        const orgImg = [...document.querySelectorAll('img')].slice(1)[0]; // skip main event img
        if (orgImg) {
          const p = orgImg.closest('[style*="cursor"]') || orgImg.parentElement;
          if (p) { p.click(); return 'org-img-parent'; }
        }
        return null;
      });
      console.log('  Org click:', orgClicked);
      await wait(2000);
      const onOrg = await waitForText(page, 'Follow', 3000) || await waitForText(page, 'Events', 3000);
      console.log('  On org profile (depth 3):', onOrg);
      await ss(page, 'D-org-profile-depth3');

      // Now back x2
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          // Back button is typically first button on screen or has ← SVG
          const back = btns.find(b => {
            const rect = b.getBoundingClientRect();
            return rect.x < 60 && rect.y < 100;
          }) || btns[0];
          if (back) back.click();
        });
        await wait(1500);
        await ss(page, `D-back-${i+1}`);
      }
    }

    // === ITEM 5: REPORT MODAL ===
    console.log('\n=== Item 5: Report ===');
    await goTab(page, 'Home');
    await wait(1500);
    // Click first event
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[style*="cursor: pointer"]')].filter(el =>
        el.offsetHeight > 100 && !el.closest('nav')
      );
      if (cards.length > 0) cards[0].click();
    });
    await waitForText(page, 'Get Tickets', 5000) || await waitForText(page, 'Interested', 4000);
    await ss(page, 'E-event-for-report');

    // Find 3-dot/more button in event header
    const moreClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      // The more button is usually last in the header, has SVG, no text
      const headerBtns = btns.filter(b => {
        const rect = b.getBoundingClientRect();
        return rect.y < 120 && b.querySelector('svg') && !b.textContent.trim();
      });
      console.log('header btns:', headerBtns.length);
      if (headerBtns.length >= 2) {
        headerBtns[headerBtns.length-1].click(); // last header svg-only button
        return `header-btn[${headerBtns.length}]`;
      }
      // Try MoreVertical / MoreHorizontal icon buttons
      const all = btns.filter(b => b.querySelector('svg'));
      const last = all[all.length-1];
      if (last) { last.click(); return 'last-svg-btn'; }
      return null;
    });
    console.log('  More button:', moreClicked);
    await wait(1200);
    await ss(page, 'E-more-menu');

    // Click Report
    const reportClick = await clickReact(page, 'Report');
    console.log('  Report click:', reportClick);
    if (!reportClick.includes('not-found')) {
      await waitForText(page, 'Report', 3000);
      await ss(page, 'E-report-modal');

      // Select a reason (Spam or first option)
      await page.evaluate(() => {
        const options = [...document.querySelectorAll('*')].filter(e =>
          !e.children.length && ['Spam','Misleading','Inappropriate','Scam','Offensive','Fake'].includes(e.textContent.trim())
        );
        if (options[0]) options[0].click();
      });
      await wait(600);
      // Submit
      const submitResult = await clickReact(page, 'Submit Report');
      console.log('  Submit:', submitResult);
      if (submitResult.includes('not-found')) {
        // Try clicking the button directly
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const sub = btns.find(b => b.textContent.includes('Submit'));
          if (sub) sub.click();
        });
      }
      await wait(2000);
      await ss(page, 'E-report-submitted');
    } else {
      // Check if we need to scroll the event detail to find 3-dot
      const body = await page.evaluate(() => document.body.innerText);
      console.log('  Report not found. Current body:', body.slice(0,80).replace(/\n/g,' '));
      await ss(page, 'E-no-report');
    }

    // === ITEM 9: ADMIN DASHBOARD ===
    console.log('\n=== Item 9: Admin Dashboard ===');
    // Sign out dero
    await goTab(page, 'Profile');
    await wait(1000);
    // Click settings gear
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Change profile photo"]');
      if (btn) btn.click();
    });
    await waitForText(page, 'ACCOUNT', 5000) || await waitForText(page, 'Security', 4000);
    await wait(500);
    // Scroll to sign out
    for (let i = 0; i < 7; i++) await scrollEl(page, 150);
    await wait(500);
    await ss(page, 'F-settings-bottom');
    const signOutClick = await clickReact(page, 'Sign Out');
    console.log('  Sign out:', signOutClick);
    await wait(1000);
    // Confirm if dialog appears
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const c = btns.find(b => ['Sign Out','Confirm','Yes','Log Out'].includes(b.textContent.trim()));
      if (c) c.click();
    });
    await waitForText(page, 'Get Started', 8000) || await waitForText(page, 'Sign in', 8000);
    await ss(page, 'F-signed-out');

    // Login as root/admin
    const adminOk = await doLogin(page, ROOT_EMAIL, ROOT_PASS);
    console.log('  Admin login:', adminOk);
    if (adminOk) {
      await wait(2000);
      await ss(page, 'G-admin-home');

      // Navigate to Admin Console via Profile menu
      await goTab(page, 'Profile');
      await wait(1500);
      await ss(page, 'G-admin-profile');

      // Look for Admin Console in menu
      const adminConsoleClick = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const btn = btns.find(b => b.textContent.includes('Admin') && b.textContent.includes('Console'));
        if (!btn) {
          // Try scrolling
          const scrollEl = [...document.querySelectorAll('*')].filter(e => {
            const cs = window.getComputedStyle(e);
            return (cs.overflowY==='auto'||cs.overflowY==='scroll') && e.scrollHeight > e.clientHeight + 10;
          }).sort((a,b) => b.scrollHeight - a.scrollHeight)[0];
          if (scrollEl) scrollEl.scrollTop += 300;
          return 'scrolled-profile';
        }
        btn.click();
        return 'admin-console-clicked';
      });
      console.log('  Admin console:', adminConsoleClick);
      await wait(1500);
      if (adminConsoleClick === 'scrolled-profile') {
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const btn = btns.find(b => b.textContent.includes('Admin') && b.textContent.includes('Console'));
          if (btn) btn.click();
        });
        await wait(1500);
      }
      const onAdmin = await waitForText(page, 'Revenue', 5000) || await waitForText(page, 'Users', 5000) || await waitForText(page, 'Reports', 5000);
      console.log('  On admin:', onAdmin);
      await ss(page, 'G-admin-dashboard');
      // Scroll to see stats
      await scrollEl(page, 300);
      await ss(page, 'G-admin-stats');
      // Check for Reports tab
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const r = btns.find(b => b.textContent.trim() === 'Reports');
        if (r) r.click();
      });
      await wait(1500);
      await ss(page, 'G-admin-reports-tab');
    }

    // === ITEM 8: VC BALANCE ===
    console.log('\n=== Item 8: VC Evidence ===');
    // Show the DB result we inserted earlier as a screenshot of the CLI output
    // (Already done via DB insert - will use CLI screenshot)
    // Show wallet/VC screen for admin user or sign back in as dero

    // Sign out admin, login dero to show VC balance
    await page.evaluate(() => {
      // Quick sign out via Profile → Settings → Sign Out
    });

    console.log('\n=== Done ===');
    const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).sort();
    files.forEach(f => console.log(' -', f));

  } catch(e) {
    console.error('Fatal:', e.message);
    await page.screenshot({ path: path.join(OUT, 'Z-fatal-error.png') });
  } finally {
    await browser.close();
  }
})();
