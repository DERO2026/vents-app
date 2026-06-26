// Final screenshots: admin dashboard + report modal + state filter open
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
  await wait(2200);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}
async function waitFor(page, text, ms=8000) {
  try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; }
}
async function body(page) { return page.evaluate(() => document.body.innerText); }

async function goBack(page) {
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(btn => {
      const r = btn.getBoundingClientRect();
      return r.x < 60 && r.y < 100 && btn.querySelector('svg');
    });
    if (b) b.click();
  });
  await wait(1200);
}

async function goToHome(page) {
  // Keep pressing back until we're on Home
  for (let i=0; i<8; i++) {
    const onHome = await page.evaluate(() => {
      const hasNav = [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Home');
      const hasBack = [...document.querySelectorAll('button')].some(b => {
        const r = b.getBoundingClientRect();
        return r.x < 60 && r.y < 100 && b.querySelector('svg');
      });
      return hasNav && !hasBack;
    });
    if (onHome) return;
    await goBack(page);
  }
  // If still stuck, click Home tab
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Home')?.click();
  });
  await wait(1000);
}

async function fillAndLogin(page, email, pass) {
  const loggedIn = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some(b => ['Home','Explore','Profile'].includes(b.textContent.trim()))
  );
  if (loggedIn) { console.log('  Already logged in'); return true; }

  const bl = (await body(page)).toLowerCase();
  if (bl.includes('get started') || bl.includes('discover')) {
    await page.evaluate(() => {
      [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Sign in' && !e.children.length)?.click();
    });
    await wait(2000);
  }
  await page.evaluate((e,p) => {
    const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    const fill = (el,v) => { if(!el)return; niv.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
    fill(document.querySelector('input[type="text"]'), e);
    fill(document.querySelector('input[type="password"]'), p);
  }, email, pass);
  await wait(400);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Sign In')?.click());
  const ok = await waitFor(page, 'Home', 15000);
  console.log(`  Login ${email}: ${ok?'✓':'✗'}`);
  if (!ok) await ss(page, 'Z-login-fail');
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
    await page.goto('https://getvents.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('button').length > 0, { timeout: 30000 });
    await wait(4000);
    await fillAndLogin(page, DERO_EMAIL, DERO_PASS);
    await wait(2000);

    // === STATE FILTER OPEN ===
    console.log('\n=== State filter dropdown ===');
    await goToHome(page);
    // Click the State: All dropdown
    const stateClicked = await page.evaluate(() => {
      // The state filter is a select/button with "State: All" text
      const el = [...document.querySelectorAll('*')].find(e =>
        e.textContent.includes('State: All') && !e.children.length
      ) || [...document.querySelectorAll('*')].find(e =>
        e.textContent.trim() === 'State: All'
      );
      if (!el) return 'not-found';
      let cur = el;
      for (let i=0; i<6; i++) {
        const pk = Object.keys(cur||{}).find(k => k.startsWith('__reactProps$'));
        if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return `reactProps[${i}]`; }
        if (cur?.tagName === 'SELECT') { cur.click(); return 'select-click'; }
        cur = cur?.parentElement;
      }
      el.click();
      return 'native';
    });
    console.log('  State filter click:', stateClicked);
    await wait(1500);
    await ss(page, 'L-state-filter-open');

    // === REPORT MODAL ===
    console.log('\n=== Report Modal ===');
    // Go to home first, close any open dropdown
    await page.keyboard.press('Escape');
    await wait(500);
    // Click Home tab
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Home')?.click());
    await wait(1500);
    // Click first event card
    await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter(i => {
        const r = i.getBoundingClientRect();
        return r.height > 60 && r.width > 100;
      });
      if (imgs[0]) {
        let cur = imgs[0];
        for (let i=0; i<6; i++) {
          const pk = Object.keys(cur||{}).find(k => k.startsWith('__reactProps$'));
          if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return; }
          if (window.getComputedStyle(cur||{}).cursor === 'pointer') { cur.click(); return; }
          cur = cur?.parentElement;
        }
        imgs[0].parentElement?.click();
      }
    });
    await wait(3000);
    const evBody = (await body(page)).slice(0,80);
    console.log('  Event detail body:', evBody.replace(/\n/g,' '));
    await ss(page, 'L-event-detail');

    // Find the flag/report button
    const flagBtnInfo = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      return btns.map(b => {
        const r = b.getBoundingClientRect();
        return {
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          text: b.textContent.trim().slice(0,15),
          hasSvg: !!b.querySelector('svg'),
          ariaLabel: b.getAttribute('aria-label') || '',
          title: b.title || ''
        };
      });
    });
    console.log('  All buttons:', JSON.stringify(flagBtnInfo.filter(b => b.y < 150)));

    // Flag button is typically 3rd icon in top-right area
    const topRightBtns = flagBtnInfo.filter(b => b.y < 80 && b.x > 200 && b.hasSvg && !b.text);
    console.log('  Top-right svg btns:', JSON.stringify(topRightBtns));
    // Click the last one (flag = report)
    if (topRightBtns.length > 0) {
      const flagBtn = topRightBtns[topRightBtns.length - 1];
      await page.mouse.click(flagBtn.x + flagBtn.w/2, flagBtn.y + flagBtn.h/2);
      await wait(1500);
      await ss(page, 'L-report-modal');
      const rBody = (await body(page)).slice(0,120);
      console.log('  Report modal body:', rBody.replace(/\n/g,' '));

      if (rBody.includes('Report') && (rBody.includes('Spam') || rBody.includes('reason') || rBody.includes('Submit') || rBody.includes('Mislead'))) {
        // Select reason
        await page.evaluate(() => {
          const reasons = ['Spam','Misleading','Inappropriate','Scam','Offensive','Fake event','Other'];
          for (const r of reasons) {
            const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim()===r && !e.children.length);
            if (el) { el.click(); return; }
          }
          // Fallback: click first interactive option
          const opts = [...document.querySelectorAll('input[type="radio"], [role="radio"]')];
          if (opts[0]) opts[0].click();
        });
        await wait(500);
        // Submit
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          btns.find(b => b.textContent.toLowerCase().includes('submit'))?.click();
        });
        await wait(2500);
        await ss(page, 'L-report-success');
        const successBody = (await body(page)).slice(0,120);
        console.log('  After submit:', successBody.replace(/\n/g,' '));
      }
    } else {
      console.log('  No top-right flag button found!');
      await ss(page, 'L-no-flag-btn');
    }

    // === SIGN OUT ===
    console.log('\n=== Sign out dero ===');
    await goToHome(page);
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Profile')?.click());
    await wait(1200);
    // Settings
    await page.evaluate(() => {
      const gear = document.querySelector('button[aria-label="Change profile photo"]') ||
        [...document.querySelectorAll('button')].find(b => b.getBoundingClientRect().x > 320 && b.getBoundingClientRect().y < 160 && b.querySelector('svg'));
      if (gear) gear.click();
    });
    await waitFor(page, 'ACCOUNT', 5000) || await waitFor(page, 'Privacy', 4000);
    // Scroll to Sign Out
    for (let i=0; i<12; i++) {
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')].filter(e => {
          const s = window.getComputedStyle(e);
          return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight > e.clientHeight+10;
        }).sort((a,b) => b.scrollHeight-a.scrollHeight);
        if (els[0]) els[0].scrollTop += 120;
      });
      await wait(150);
      const found = await page.evaluate(() =>
        [...document.querySelectorAll('*')].some(e => e.textContent.trim()==='Sign Out' && !e.children.length)
      );
      if (found) break;
    }
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
    await wait(1000);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find(b => ['Sign Out','Confirm','Yes','Log Out','Sign out'].some(s => b.textContent.trim()===s))?.click();
    });
    await waitFor(page, 'Get Started', 8000) || await waitFor(page, 'Sign in', 6000);
    console.log('  Signed out ✓');

    // === ADMIN LOGIN ===
    console.log('\n=== Admin login ===');
    const adminOk = await fillAndLogin(page, ROOT_EMAIL, ROOT_PASS);
    if (!adminOk) {
      console.log('  Admin login failed!');
      await browser.close();
      return;
    }
    await wait(2000);
    await ss(page, 'M-admin-home');

    // Go to Profile → Admin Console
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Profile')?.click());
    await wait(1500);
    await ss(page, 'M-admin-profile');
    // Find Admin Console button
    for (let i=0; i<4; i++) {
      const found = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b =>
          b.textContent.includes('Admin') || b.textContent.includes('Console')
        );
        if (btn) { btn.click(); return true; }
        const els = [...document.querySelectorAll('*')].filter(e => {
          const s = window.getComputedStyle(e);
          return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight > e.clientHeight+10;
        }).sort((a,b) => b.scrollHeight-a.scrollHeight);
        if (els[0]) els[0].scrollTop += 100;
        return false;
      });
      if (found) break;
      await wait(400);
    }
    await waitFor(page, 'Revenue', 6000) || await waitFor(page, 'Users', 5000) || await waitFor(page, 'Reports', 5000) || await waitFor(page, 'Admin', 4000);
    await wait(500);
    await ss(page, 'M-admin-dashboard');
    const adminBody = (await body(page)).slice(0,300);
    console.log('  Admin body:', adminBody.replace(/\n/g,' '));

    // Scroll to see stats
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('*')].filter(e => {
        const s = window.getComputedStyle(e);
        return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight > e.clientHeight+10;
      }).sort((a,b) => b.scrollHeight-a.scrollHeight);
      if (els[0]) els[0].scrollTop += 300;
    });
    await wait(1000);
    await ss(page, 'M-admin-dashboard-scrolled');

    // Click Reports tab
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      btns.find(b => b.textContent.trim()==='Reports')?.click();
    });
    await wait(1500);
    await ss(page, 'M-admin-reports');
    const reportsBody = (await body(page)).slice(0,200);
    console.log('  Reports tab:', reportsBody.replace(/\n/g,' '));

    // Click Users tab
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Users')?.click();
    });
    await wait(1200);
    await ss(page, 'M-admin-users');

    // Check for ban/reinstate buttons
    const hasBan = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      return btns.some(b => b.textContent.includes('Ban') || b.textContent.includes('Reinstate'));
    });
    console.log('  Ban/reinstate visible:', hasBan);

    console.log('\n=== Done ===');

  } catch(e) {
    console.error('FATAL:', e.message, e.stack?.slice(0,200));
    try { await ss(page, 'Z-fatal'); } catch {}
  } finally {
    await browser.close();
  }
})();
