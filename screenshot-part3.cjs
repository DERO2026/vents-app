// Part 3: Event detail, report, admin dashboard, my tickets
// Always go Back before using tab navigation
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
  await wait(2500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}

async function waitForText(page, text, timeout = 8000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
    return true;
  } catch { return false; }
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

// Go back to base (home) by pressing back until we see Home tab active
async function goHome(page) {
  for (let i = 0; i < 10; i++) {
    const onHome = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const homeBtn = btns.find(b => b.textContent.trim() === 'Home');
      if (!homeBtn) return false;
      // If Home tab is visible but we're on a sub-screen, the bottom nav is still there
      // Check if we have a back button (indicating we're in a push screen)
      const backBtn = document.querySelector('button[aria-label="Go back"]') ||
        [...document.querySelectorAll('button')].find(b => {
          const rect = b.getBoundingClientRect();
          return rect.x < 60 && rect.y < 80 && b.querySelector('svg');
        });
      return !backBtn;
    });
    if (onHome) return;

    // Press back
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const back = btns.find(b => {
        const rect = b.getBoundingClientRect();
        return rect.x < 60 && rect.y < 80 && b.querySelector('svg');
      });
      if (back) back.click();
      else {
        // Try clicking Home tab directly
        const h = btns.find(b => b.textContent.trim() === 'Home');
        if (h) h.click();
      }
    });
    await wait(800);
  }
}

async function goTab(page, name) {
  await goHome(page);
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
      return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight > e.clientHeight+10;
    }).sort((a,b) => b.scrollHeight-a.scrollHeight);
    (els[0] || window).scrollTop ? els[0].scrollTop += p : window.scrollBy(0,p);
  }, px);
  await wait(500);
}

async function doLogin(page, email, pass) {
  const loggedIn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.some(b => ['Home','Explore','Profile'].includes(b.textContent.trim()));
  });
  if (loggedIn) { console.log('  Already logged in'); return true; }

  const bl = await page.evaluate(() => document.body.innerText.toLowerCase());
  if (bl.includes('get started') || bl.includes('discover nigeria')) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Sign in' && !e.children.length);
      if (el) el.click();
    });
    await wait(2000);
  }

  await page.evaluate((e, p) => {
    const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    const fill = (el,v) => { if(!el) return; niv.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
    fill(document.querySelector('input[type="text"]'), e);
    fill(document.querySelector('input[type="password"]'), p);
  }, email, pass);
  await wait(500);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Sign In');
    if (btn) btn.click();
  });
  const ok = await waitForText(page, 'Home', 15000);
  console.log(`  Login ${email}:`, ok ? '✓' : '✗');
  if (!ok) await ss(page, 'Z-login-fail-' + email.split('@')[0]);
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
    console.log('\n=== Load + Login dero ===');
    await page.goto('https://getvents.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('button').length > 0, { timeout: 30000 });
    await wait(4000);
    await doLogin(page, DERO_EMAIL, DERO_PASS);
    await wait(2000);

    // === MY TICKETS (tab navigation) ===
    console.log('\n=== My Tickets ===');
    await goHome(page);
    // Click Tickets tab from bottom nav
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find(b => b.textContent.trim() === 'Tickets');
      if (t) t.click();
    });
    const onTickets = await waitForText(page, 'ticket', 5000) || await waitForText(page, 'Ticket', 4000) || await waitForText(page, 'No ', 4000);
    console.log('  On tickets:', onTickets, '| body:', (await bodyText(page)).slice(0,80).replace(/\n/g,' '));
    await ss(page, 'H-my-tickets');

    // === EVENT DETAIL + REPORT ===
    console.log('\n=== Event Detail + Report ===');
    await goHome(page);
    await wait(1000);
    // Verify on home
    const homeBody = (await bodyText(page)).slice(0,60);
    console.log('  Home body:', homeBody.replace(/\n/g,' '));

    // Click first event card
    const evClicked = await page.evaluate(() => {
      // Look for clickable event cards - large divs with images and cursor pointer
      // Strategy 1: find divs with object-fit cover images
      const imgs = [...document.querySelectorAll('img')].filter(i => {
        const cs = window.getComputedStyle(i);
        const rect = i.getBoundingClientRect();
        return rect.height > 60 && rect.width > 100;
      });
      if (imgs.length > 0) {
        // Walk up to find clickable ancestor
        let el = imgs[0];
        for (let i = 0; i < 5; i++) {
          if (!el) break;
          const pk = Object.keys(el).find(k => k.startsWith('__reactProps$'));
          if (pk && el[pk]?.onClick) {
            el[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} });
            return `react-img-parent[depth=${i}]`;
          }
          if (window.getComputedStyle(el).cursor === 'pointer') {
            el.click();
            return `cursor-pointer-img-parent[depth=${i}]`;
          }
          el = el.parentElement;
        }
        imgs[0].parentElement?.click();
        return 'fallback-img-parent';
      }
      return null;
    });
    console.log('  Event card clicked:', evClicked);
    const onEventDetail = await waitForText(page, 'Get Tickets', 5000) || await waitForText(page, 'Interested', 5000) || await waitForText(page, 'Share', 4000);
    const eventBodyText = (await bodyText(page)).slice(0,80).replace(/\n/g,' ');
    console.log('  On event detail:', onEventDetail, '|', eventBodyText);
    await ss(page, 'H-event-detail');

    if (onEventDetail || eventBodyText.includes('Share') || eventBodyText.includes('Buy') || eventBodyText.includes('₦')) {
      // Find more/3-dot button in event header (top right)
      const headerBtns = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.map(b => {
          const r = b.getBoundingClientRect();
          return {
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
            text: b.textContent.trim().slice(0,20),
            hasSvg: !!b.querySelector('svg'),
            ariaLabel: b.getAttribute('aria-label')
          };
        });
      });
      console.log('  Buttons:', JSON.stringify(headerBtns));

      // Click the last SVG-only button in top portion
      const moreBtn = headerBtns.filter(b => b.y < 120 && b.hasSvg && !b.text).pop();
      console.log('  More button candidate:', moreBtn);

      if (moreBtn) {
        await page.mouse.click(moreBtn.x + moreBtn.w/2, moreBtn.y + 20);
        await wait(1200);
        await ss(page, 'H-event-more-menu');
        const menuBody = (await bodyText(page)).slice(0,120);
        console.log('  Menu body:', menuBody.replace(/\n/g,' '));

        // Try to find "Report" in the menu
        const hasReport = await page.evaluate(() =>
          [...document.querySelectorAll('*')].some(e => e.textContent.trim() === 'Report' && !e.children.length)
        );
        console.log('  Has Report option:', hasReport);

        if (hasReport) {
          await page.evaluate(() => {
            const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim() === 'Report' && !e.children.length);
            if (el) {
              let cur = el;
              for (let i=0; i<8; i++) {
                if (!cur) break;
                const pk = Object.keys(cur).find(k => k.startsWith('__reactProps$'));
                if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return; }
                cur = cur.parentElement;
              }
              el.click();
            }
          });
          await wait(1500);
          await ss(page, 'H-report-modal');
          const rBody = (await bodyText(page)).slice(0,100);
          console.log('  Report modal body:', rBody.replace(/\n/g,' '));

          // Select first reason
          await page.evaluate(() => {
            const reasons = ['Spam','Misleading','Inappropriate','Scam','Offensive','Other','Fake event'];
            for (const r of reasons) {
              const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim()===r && !e.children.length);
              if (el) { el.click(); return; }
            }
            // Click first option-like element
            const opts = [...document.querySelectorAll('[role="radio"], input[type="radio"]')];
            if (opts[0]) opts[0].click();
          });
          await wait(500);

          // Submit
          await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const sub = btns.find(b => b.textContent.includes('Submit'));
            if (sub) sub.click();
          });
          await wait(2000);
          await ss(page, 'H-report-submitted');
        } else {
          // The more menu didn't show Report - maybe it's hidden or a different button
          console.log('  No Report in menu. Trying different approach.');
          // Close menu and try right-most top button
          await page.keyboard.press('Escape');
          await wait(500);
        }
      }

      // 3-deep navigation: event detail → organizer profile → back back
      console.log('\n  3-deep nav test:');
      // If on event detail, try clicking on organizer area
      const orgArea = await page.evaluate(() => {
        // Look for "Organised by" or organizer profile link
        const all = [...document.querySelectorAll('*')];
        const orgLabel = all.find(e => !e.children.length && (e.textContent.includes('Organised by') || e.textContent.includes('Organized by') || e.textContent.includes('Host:')));
        if (orgLabel) {
          let cur = orgLabel;
          for (let i=0; i<5; i++) {
            const pk = Object.keys(cur||{}).find(k => k.startsWith('__reactProps$'));
            if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return `org-label-clicked[depth=${i}]`; }
            cur = cur?.parentElement;
          }
          orgLabel.click();
          return 'org-label-native-click';
        }
        // Try second img (organizer avatar)
        const imgs = [...document.querySelectorAll('img')];
        if (imgs.length >= 2) {
          const avatar = imgs[1];
          let cur = avatar;
          for (let i=0; i<5; i++) {
            const pk = Object.keys(cur||{}).find(k => k.startsWith('__reactProps$'));
            if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return `avatar-clicked[depth=${i}]`; }
            cur = cur?.parentElement;
          }
          return 'avatar-no-click';
        }
        return 'no-org-found';
      });
      console.log('  Org click:', orgArea);
      await wait(2000);
      const depth3body = (await bodyText(page)).slice(0,80);
      console.log('  Depth3 body:', depth3body.replace(/\n/g,' '));
      await ss(page, 'H-depth3-org-profile');
      // Back from org profile
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const back = btns.find(b => { const r=b.getBoundingClientRect(); return r.x<60 && r.y<100 && b.querySelector('svg'); });
        if (back) back.click();
      });
      await wait(1200);
      await ss(page, 'H-back-to-event');
      // Back from event to home
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const back = btns.find(b => { const r=b.getBoundingClientRect(); return r.x<60 && r.y<100 && b.querySelector('svg'); });
        if (back) back.click();
      });
      await wait(1200);
      await ss(page, 'H-back-to-home');
    }

    // === ADMIN DASHBOARD ===
    console.log('\n=== Admin Dashboard ===');
    await goHome(page);

    // Sign out via Settings
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find(b => b.textContent.trim() === 'Profile')?.click();
    });
    await wait(1500);
    // Settings gear button
    await page.evaluate(() => {
      const gear = document.querySelector('button[aria-label="Change profile photo"]') ||
                   [...document.querySelectorAll('button')].find(b => b.querySelector('svg') && b.getBoundingClientRect().x > 300);
      if (gear) gear.click();
    });
    await waitForText(page, 'ACCOUNT', 5000) || await waitForText(page, 'Privacy', 4000);
    await wait(500);

    // Scroll way down to Sign Out
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')].filter(e => {
          const s = window.getComputedStyle(e);
          return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight > e.clientHeight+10;
        }).sort((a,b) => b.scrollHeight-a.scrollHeight);
        if (els[0]) els[0].scrollTop += 200;
      });
      await wait(200);
      const hasSignOut = await page.evaluate(() =>
        [...document.querySelectorAll('*')].some(e => e.textContent.trim()==='Sign Out' && !e.children.length)
      );
      if (hasSignOut) break;
    }
    await ss(page, 'I-settings-signout');

    // Click Sign Out
    await page.evaluate(() => {
      let el = [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Sign Out' && !e.children.length);
      if (!el) return;
      let cur = el;
      for (let i=0; i<8; i++) {
        const pk = Object.keys(cur||{}).find(k => k.startsWith('__reactProps$'));
        if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return; }
        cur = cur?.parentElement;
      }
      el.click();
    });
    await wait(1200);

    // Confirm dialog
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const c = btns.find(b => ['Sign Out','Confirm','Yes','Log Out','Sign out'].some(s => b.textContent.trim()===s));
      if (c) c.click();
    });
    await wait(2500);

    const signedOut = await waitForText(page, 'Get Started', 6000) || await waitForText(page, 'Sign in', 5000) || await waitForText(page, 'Discover Nigeria', 5000);
    console.log('  Signed out:', signedOut);
    await ss(page, 'I-after-signout');

    // Login as admin/root
    const adminOk = await doLogin(page, ROOT_EMAIL, ROOT_PASS);
    if (adminOk) {
      await wait(2000);
      await ss(page, 'I-admin-home');
      // Go to Profile
      await page.evaluate(() => {
        [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Profile')?.click();
      });
      await wait(1500);
      await ss(page, 'I-admin-profile');

      // Find Admin Console in menu
      let adminConsoleFount = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const btn = btns.find(b => b.textContent.includes('Admin') || b.textContent.includes('Console'));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!adminConsoleFount) {
        // Scroll profile
        for (let i=0; i<3; i++) {
          await page.evaluate(() => {
            const els = [...document.querySelectorAll('*')].filter(e => {
              const s = window.getComputedStyle(e);
              return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight > e.clientHeight+10;
            }).sort((a,b) => b.scrollHeight-a.scrollHeight);
            if (els[0]) els[0].scrollTop += 150;
          });
          await wait(300);
          adminConsoleFount = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Admin') || b.textContent.includes('Console'));
            if (btn) { btn.click(); return true; }
            return false;
          });
          if (adminConsoleFount) break;
        }
      }
      console.log('  Admin console found:', adminConsoleFount);
      await waitForText(page, 'Revenue', 6000) || await waitForText(page, 'Reports', 6000) || await waitForText(page, 'Users', 5000);
      await wait(500);
      await ss(page, 'I-admin-dashboard');
      const adminBody = (await bodyText(page)).slice(0,200);
      console.log('  Admin dashboard body:', adminBody.replace(/\n/g,' '));

      // Check Reports tab
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const r = btns.find(b => b.textContent.trim()==='Reports');
        if (r) r.click();
      });
      await wait(1200);
      await ss(page, 'I-admin-reports');

      // VC balance for evidence - check if there's a VC/wallet section
      // Go back to profile for VC balance display
      await goHome(page);
    } else {
      console.log('  Admin login failed - check credentials');
    }

    // === VC BALANCE VIEW (sign back in as dero) ===
    console.log('\n=== VC Balance (dero) ===');
    if (!adminOk) {
      // Already dero - go to wallet
    } else {
      // Sign out admin, sign in dero
      await page.evaluate(() => {
        [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Profile')?.click();
      });
      await wait(1000);
      await page.evaluate(() => {
        document.querySelector('button[aria-label="Change profile photo"]')?.click() ||
        [...document.querySelectorAll('button')].find(b => b.querySelector('svg') && b.getBoundingClientRect().x > 300)?.click();
      });
      await waitForText(page, 'ACCOUNT', 4000);
      for (let i=0; i<10; i++) {
        await page.evaluate(() => {
          const els = [...document.querySelectorAll('*')].filter(e => {
            const s = window.getComputedStyle(e);
            return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight > e.clientHeight+10;
          }).sort((a,b) => b.scrollHeight-a.scrollHeight);
          if (els[0]) els[0].scrollTop += 200;
        });
        await wait(150);
        const hasSignOut = await page.evaluate(() =>
          [...document.querySelectorAll('*')].some(e => e.textContent.trim()==='Sign Out' && !e.children.length)
        );
        if (hasSignOut) break;
      }
      await page.evaluate(() => {
        let el = [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Sign Out' && !e.children.length);
        if (!el) return;
        let cur = el;
        for (let i=0; i<8; i++) {
          const pk = Object.keys(cur||{}).find(k => k.startsWith('__reactProps$'));
          if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return; }
          cur = cur?.parentElement;
        }
        el.click();
      });
      await wait(1000);
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        btns.find(b => ['Sign Out','Confirm','Yes'].includes(b.textContent.trim()))?.click();
      });
      await waitForText(page, 'Get Started', 6000) || await waitForText(page, 'Sign in', 5000);
      await doLogin(page, DERO_EMAIL, DERO_PASS);
      await wait(2000);
    }

    // Find Vents Cents / wallet in profile
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Profile')?.click();
    });
    await wait(1500);
    const vcVisible = await page.evaluate(() => document.body.innerText.includes('Vents Cents') || document.body.innerText.includes('VC') || document.body.innerText.includes('Wallet'));
    console.log('  VC/wallet visible on profile:', vcVisible);
    await ss(page, 'J-profile-vc');
    // Look for wallet/VC menu item
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const w = btns.find(b => b.textContent.includes('Wallet') || b.textContent.includes('Vents Cents') || b.textContent.includes('Cents'));
      if (w) w.click();
    });
    await wait(2000);
    const walletBody = (await bodyText(page)).slice(0,100);
    console.log('  Wallet body:', walletBody.replace(/\n/g,' '));
    await ss(page, 'J-vc-wallet');

    console.log('\n=== All done ===');
    fs.readdirSync(OUT).filter(f=>/^[A-Z]-/.test(f)).sort().forEach(f => console.log(' -',f));

  } catch(e) {
    console.error('FATAL:', e.message);
    try { await ss(page, 'Z-fatal'); } catch {}
  } finally {
    await browser.close();
  }
})();
