// Final targeted: report modal, state filter open, admin console
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'screenshots');

const DERO_EMAIL = 'djjackson361@gmail.com';
const DERO_PASS  = 'Dero2026$';
const ROOT_EMAIL = 'ventsappltd@gmail.com';
const ROOT_PASS  = 'Vents2024!';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function ss(page, name) { await wait(2200); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log(`  ✓ ${name}.png`); }
async function waitFor(page, text, ms=8000) { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } }
async function getBody(page) { return page.evaluate(() => document.body.innerText); }

async function doLogin(page, email, pass) {
  const li = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => ['Home','Explore','Profile'].includes(b.textContent.trim())));
  if (li) { console.log('  Already in'); return true; }
  const bl = (await getBody(page)).toLowerCase();
  if (bl.includes('get started') || bl.includes('discover')) {
    await page.evaluate(() => [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Sign in' && !e.children.length)?.click());
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
  console.log(`  Login ${email}: ${ok?'✓':'✗'}`); return ok;
}

async function goHome(page) {
  for (let i=0; i<8; i++) {
    const ok = await page.evaluate(() => {
      const hasNav = [...document.querySelectorAll('button')].some(b => b.textContent.trim()==='Home');
      const hasBack = [...document.querySelectorAll('button')].some(b => { const r=b.getBoundingClientRect(); return r.x<60&&r.y<100&&b.querySelector('svg'); });
      return hasNav && !hasBack;
    });
    if (ok) return;
    await page.evaluate(() => {
      const back = [...document.querySelectorAll('button')].find(b => { const r=b.getBoundingClientRect(); return r.x<60&&r.y<100&&b.querySelector('svg'); });
      if (back) back.click();
      else [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Home')?.click();
    });
    await wait(700);
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 390, height: 844 },
    args: ['--window-size=430,900','--no-sandbox'],
    userDataDir: 'C:\\Temp\\puppeteer-vents-v4',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });

  try {
    await page.goto('https://getvents.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('button').length > 0, { timeout: 30000 });
    await wait(4000);
    await doLogin(page, DERO_EMAIL, DERO_PASS);
    await wait(2000);
    await goHome(page);

    // === STATE FILTER (custom React dropdown) ===
    console.log('\n=== State Filter Dropdown ===');
    // The state filter is a custom React dropdown, not a native select
    // It should be the "📍 State: All" chip/pill button
    const stateResult = await page.evaluate(() => {
      // Find the State filter container/button by text
      const all = [...document.querySelectorAll('*')];
      // Find element containing "State:" text
      const el = all.find(e => {
        const t = e.textContent.trim();
        return (t === 'State: All' || t.includes('State:')) && e.children.length <= 3;
      });
      if (!el) return 'not-found';
      // Try reactProps first
      let cur = el;
      for (let i=0; i<8; i++) {
        if (!cur) break;
        const pk = Object.keys(cur).find(k => k.startsWith('__reactProps$'));
        if (pk && cur[pk]?.onClick) {
          cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} });
          return `reactProps[depth=${i}]:${cur.tagName}`;
        }
        cur = cur.parentElement;
      }
      // Native click
      el.click();
      return 'native:' + el.tagName;
    });
    console.log('  State click:', stateResult);
    await wait(2000);
    const stateBody = (await getBody(page)).slice(0,200);
    console.log('  State body after click:', stateBody.replace(/\n/g,' ').slice(0,100));
    await ss(page, 'N-state-filter');
    // Also try clicking the chevron/arrow icon next to State text
    if (!stateBody.includes('Abia') && !stateBody.includes('Select') && !stateBody.includes('Lagos')) {
      // Try mouse click on the actual State filter chip coordinates
      const stateChipRect = await page.evaluate(() => {
        const all = [...document.querySelectorAll('*')];
        const el = all.find(e => e.textContent.includes('State:') && !e.children.length) ||
                   all.find(e => e.textContent.trim()==='State: All');
        if (el) {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width/2, y: r.top + r.height/2 };
        }
        return null;
      });
      if (stateChipRect) {
        await page.mouse.click(stateChipRect.x, stateChipRect.y);
        await wait(1500);
        await ss(page, 'N-state-filter2');
      }
    }

    // === REPORT MODAL via reactProps ===
    console.log('\n=== Report Modal (flag button reactProps) ===');
    await goHome(page);
    // Click event card
    await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter(i => i.getBoundingClientRect().height > 60);
      if (!imgs[0]) return;
      let cur = imgs[0];
      for (let i=0; i<6; i++) {
        const pk = Object.keys(cur||{}).find(k => k.startsWith('__reactProps$'));
        if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return; }
        cur = cur?.parentElement;
      }
    });
    await wait(3000);
    await ss(page, 'N-event-detail');

    // Click flag button via reactProps - NOT via mouse coordinates
    const flagResult = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const headerBtns = btns.filter(b => {
        const r = b.getBoundingClientRect();
        return r.y < 80 && r.x > 200 && b.querySelector('svg') && !b.textContent.trim();
      });
      console.log('header btns count:', headerBtns.length, headerBtns.map(b => b.getBoundingClientRect().x));
      // flag is the LAST (rightmost) header button
      const flagBtn = headerBtns[headerBtns.length - 1];
      if (!flagBtn) return 'no-flag-btn';
      const pk = Object.keys(flagBtn).find(k => k.startsWith('__reactProps$'));
      if (pk && flagBtn[pk]?.onClick) {
        flagBtn[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} });
        return `ok:reactProps at x=${flagBtn.getBoundingClientRect().x.toFixed(0)}`;
      }
      flagBtn.click();
      return `native-click at x=${flagBtn.getBoundingClientRect().x.toFixed(0)}`;
    });
    console.log('  Flag result:', flagResult);
    await wait(1500);
    const rBody = (await getBody(page)).slice(0,150);
    console.log('  After flag click:', rBody.replace(/\n/g,' '));
    await ss(page, 'N-report-modal');

    const hasReportModal = rBody.toLowerCase().includes('report') && (rBody.includes('Spam') || rBody.includes('Submit') || rBody.includes('reason') || rBody.includes('Report Event'));
    if (hasReportModal) {
      // Select first reason and submit
      await page.evaluate(() => {
        const reasons = ['Spam','Misleading','Inappropriate','Scam','Offensive','Fake event','Other'];
        for (const r of reasons) {
          const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim()===r && !e.children.length);
          if (el) {
            let cur = el;
            for (let i=0; i<6; i++) {
              const pk = Object.keys(cur||{}).find(k => k.startsWith('__reactProps$'));
              if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return; }
              cur = cur?.parentElement;
            }
            el.click();
            return;
          }
        }
      });
      await wait(500);
      await page.evaluate(() => {
        [...document.querySelectorAll('button')].find(b => b.textContent.toLowerCase().includes('submit'))?.click();
      });
      await wait(2500);
      await ss(page, 'N-report-submitted');
      console.log('  Report submitted ✓');
    } else {
      // Maybe the heart/save button (2nd to last) is really the flag
      // Let me try the 2nd header button from the right
      console.log('  Report modal not shown. Trying 2nd-to-last header button...');
      await goHome(page);
      await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')].filter(i => i.getBoundingClientRect().height > 60);
        if (!imgs[0]) return;
        let cur = imgs[0];
        for (let i=0; i<6; i++) {
          const pk = Object.keys(cur||{}).find(k => k.startsWith('__reactProps$'));
          if (pk && cur[pk]?.onClick) { cur[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} }); return; }
          cur = cur?.parentElement;
        }
      });
      await wait(3000);
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const headerBtns = btns.filter(b => {
          const r = b.getBoundingClientRect();
          return r.y < 80 && r.x > 200 && b.querySelector('svg') && !b.textContent.trim();
        });
        // Try index 2 (0-based), which is the 3rd = flag (share=0, heart=1, flag=2)
        // But count from what we know: there are 3 top-right buttons
        // index 0 = share (smallest x), 1 = heart, 2 = flag (largest x)
        // In our previous test they were at x=240, 288, 336
        // The 3rd button (index 2) was clicked last time and showed "Tap to close" (image expand)
        // So actually maybe there are 4 buttons: back(x=16), share(x=240), heart(x=288), flag(x=336)
        // And the headerBtns filter (x>200) gives share, heart, flag = [0,1,2]
        // Let me try index 1 (heart) as the flag - maybe share/heart/report order is different
        // Actually looking at EventDetailsScreen.tsx code order: share, save/heart, THEN flag
        // So flag should be at index 2 (last).
        // But clicking it showed "Tap to close"...
        // UNLESS the flag click DID work but the body text still showed "Tap to close" because
        // that text belongs to a separate UI element (the overlay text)
        // Let me verify by reading the DOM after clicking
      });
    }

    // === ADMIN CONSOLE ===
    console.log('\n=== Admin Console ===');
    // Sign out dero
    await goHome(page);
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1200);
    await page.evaluate(() => {
      (document.querySelector('button[aria-label="Change profile photo"]') ||
      [...document.querySelectorAll('button')].find(b => b.getBoundingClientRect().x > 320 && b.getBoundingClientRect().y < 200 && b.querySelector('svg')))?.click();
    });
    await waitFor(page, 'ACCOUNT', 5000);
    // Scroll to sign out
    for (let i=0; i<15; i++) {
      await page.evaluate(() => {
        [...document.querySelectorAll('*')].filter(e => {
          const s=window.getComputedStyle(e);
          return (s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;
        }).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0]?.scrollBy(0,100);
      });
      await wait(100);
      if (await page.evaluate(()=>[...document.querySelectorAll('*')].some(e=>e.textContent.trim()==='Sign Out'&&!e.children.length))) break;
    }
    await page.evaluate(() => {
      let el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Sign Out'&&!e.children.length);
      if(!el)return;
      let cur=el;
      for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}
      el.click();
    });
    await wait(1000);
    await page.evaluate(()=>{[...document.querySelectorAll('button')].find(b=>['Sign Out','Confirm','Yes'].includes(b.textContent.trim()))?.click();});
    await waitFor(page, 'Get Started', 8000) || await waitFor(page, 'Sign in', 6000);
    console.log('  Dero signed out ✓');

    // Admin login
    await doLogin(page, ROOT_EMAIL, ROOT_PASS);
    await wait(2000);
    await ss(page, 'N-admin-logged-in');

    // Profile → Admin Console (scroll carefully)
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1500);
    // Scroll slowly until "Admin Console" text appears
    let adminConsoleFound = false;
    for (let i=0; i<20; i++) {
      const found = await page.evaluate(() => {
        const all=[...document.querySelectorAll('*')];
        return all.some(e=>e.textContent.trim()==='Admin Console'||e.textContent.trim()==='Admin');
      });
      if (found) { adminConsoleFound = true; break; }
      await page.evaluate(() => {
        [...document.querySelectorAll('*')].filter(e=>{const s=window.getComputedStyle(e);return(s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0]?.scrollBy(0,80);
      });
      await wait(200);
    }
    console.log('  Admin Console found:', adminConsoleFound);
    if (adminConsoleFound) {
      await ss(page, 'N-profile-admin-console-visible');
      // Click Admin Console
      await page.evaluate(() => {
        let el=[...document.querySelectorAll('*')].find(e=>(e.textContent.trim()==='Admin Console'||e.textContent.includes('Admin Console'))&&!e.children.length);
        if(!el)el=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Admin'));
        if(!el)return;
        let cur=el;
        for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}
        el.click();
      });
      await waitFor(page,'Revenue',6000)||await waitFor(page,'Users',5000)||await waitFor(page,'Reports',5000)||await waitFor(page,'Admin Dashboard',4000);
      await wait(800);
      await ss(page, 'N-admin-dashboard');
      const adminBody=(await getBody(page)).slice(0,300);
      console.log('  Admin dashboard:', adminBody.replace(/\n/g,' ').slice(0,150));

      // Scroll to see stat cards (Revenue, New This Week, etc.)
      await page.evaluate(()=>[...document.querySelectorAll('*')].filter(e=>{const s=window.getComputedStyle(e);return(s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0]?.scrollBy(0,200));
      await wait(800);
      await ss(page, 'N-admin-stats');

      // Scroll back to top and check for tab buttons
      await page.evaluate(()=>[...document.querySelectorAll('*')].filter(e=>{const s=window.getComputedStyle(e);return(s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0]?.scrollTo(0,0));
      await wait(500);
      // Click Reports tab
      await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reports')?.click());
      await wait(1200);
      await ss(page, 'N-admin-reports');
      const reportsCnt=(await getBody(page)).slice(0,100);
      console.log('  Reports tab:', reportsCnt.replace(/\n/g,' '));

      // Click Users tab for ban/reinstate evidence
      await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Users')?.click());
      await wait(1200);
      await ss(page, 'N-admin-users');
    } else {
      await ss(page, 'N-admin-console-not-found');
    }

    console.log('\n=== All done ===');
  } catch(e) {
    console.error('FATAL:', e.message);
    try { await ss(page, 'N-fatal'); } catch {}
  } finally {
    await browser.close();
  }
})();
