// Final pass: admin stats, report submit, state filter, settings no-dup-role,
// my-tickets organizer, 3-deep nav, follow counts, username validation, organizer reviews
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const DERO_EMAIL = 'djjackson361@gmail.com';
const DERO_PASS  = 'Dero2026$';
const ROOT_EMAIL = 'ventsappltd@gmail.com';
const ROOT_PASS  = 'Vents2024!';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function ss(page, name) {
  await wait(2000);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}
async function waitFor(page, text, ms=8000) {
  try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; }
}
async function body(page) { return page.evaluate(() => document.body.innerText); }

async function goBack(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(btn => {
      const r = btn.getBoundingClientRect();
      return r.x < 60 && r.y < 100 && btn.querySelector('svg');
    });
    if (b) b.click();
  });
  await wait(1200);
}

async function goHome(page) {
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
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Home')?.click());
  await wait(800);
}

async function login(page, email, pass) {
  const loggedIn = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some(b => ['Home','Explore','Profile'].includes(b.textContent.trim()))
  );
  if (loggedIn) return true;
  const bl = (await body(page)).toLowerCase();
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
  console.log(`  login(${email}): ${ok?'✓':'✗'}`);
  return ok;
}

async function clickTab(page, label) {
  await page.evaluate(t => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim()===t);
    if (btn) { const pk = Object.keys(btn).find(k=>k.startsWith('__reactProps$')); if(pk&&btn[pk]?.onClick) btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}}); else btn.click(); }
  }, label);
  await wait(1500);
}

async function signOut(page) {
  await goHome(page);
  await clickTab(page, 'Profile');
  // scroll to sign out
  for (let i=0; i<15; i++) {
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('*')].filter(e=>{const s=window.getComputedStyle(e);return(s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
      if(els[0]) els[0].scrollTop += 100; else window.scrollBy(0,100);
    });
    await wait(100);
    const found = await page.evaluate(() => [...document.querySelectorAll('*')].some(e=>e.textContent.trim()==='Sign Out'&&!e.children.length));
    if (found) break;
  }
  await page.evaluate(() => {
    let el = [...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Sign Out'&&!e.children.length);
    if (!el) return;
    let cur = el;
    for (let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}
    el.click();
  });
  await wait(800);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b=>['Sign Out','Confirm','Yes','Log Out'].includes(b.textContent.trim()))?.click());
  await waitFor(page,'Get Started',6000) || await waitFor(page,'Sign in',5000);
  console.log('  signed out');
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

    // ============================================================
    // PART A: DERO SESSION
    // ============================================================
    console.log('\n=== A: Login dero ===');
    await login(page, DERO_EMAIL, DERO_PASS);
    await wait(2000);

    // ---------- A1: STATE FILTER OPEN ----------
    console.log('\n--- A1: State filter ---');
    await goHome(page);
    await waitFor(page, 'State: All', 5000);
    // Try clicking the "State: All" chip
    const stateResult = await page.evaluate(() => {
      // Find by partial text match
      const allEls = [...document.querySelectorAll('*')];
      const el = allEls.find(e => e.textContent.trim()==='State: All' && e.children.length<=2) ||
                 allEls.find(e => e.textContent.includes('State: All') && !e.querySelector('select'));
      if (!el) return 'not-found';
      let cur = el;
      for (let i=0;i<8;i++) {
        const pk = Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));
        if (pk&&cur[pk]?.onClick) { cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}}); return `reactProps[${i}]`; }
        if (cur.tagName==='SELECT') { cur.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 'select-mousedown'; }
        cur=cur?.parentElement;
      }
      el.click(); return 'native';
    });
    console.log('  state click:', stateResult);
    await wait(1500);
    await ss(page, 'P-state-filter-open');
    // Check if dropdown opened
    const stateBody = (await body(page)).slice(0,200);
    console.log('  state body:', stateBody.replace(/\n/g,' ').slice(0,100));

    // ---------- A2: REPORT SUBMIT ----------
    console.log('\n--- A2: Report submit ---');
    await page.keyboard.press('Escape');
    await wait(500);
    await goHome(page);
    // Click first event
    await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter(i => {
        const r = i.getBoundingClientRect();
        return r.height > 60 && r.width > 100 && r.top > 50 && r.top < 700;
      });
      if (imgs[0]) {
        let cur = imgs[0];
        for (let i=0;i<6;i++) {
          const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));
          if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}
          if(window.getComputedStyle(cur||{}).cursor==='pointer'){cur.click();return;}
          cur=cur?.parentElement;
        }
        imgs[0].parentElement?.click();
      }
    });
    await waitFor(page, 'Date', 6000) || await waitFor(page, 'Time', 4000);
    await wait(2000);
    await ss(page, 'P-event-detail');

    // Click flag button using reactProps
    const flagResult = await page.evaluate(() => {
      // Find buttons in header area (y < 80)
      const btns = [...document.querySelectorAll('button')].filter(b => {
        const r = b.getBoundingClientRect();
        return r.y < 80 && r.y >= 0 && r.x > 200 && b.querySelector('svg');
      });
      // Last one should be flag
      const flagBtn = btns[btns.length-1];
      if (!flagBtn) return 'not-found';
      const pk = Object.keys(flagBtn).find(k=>k.startsWith('__reactProps$'));
      if (pk&&flagBtn[pk]?.onClick) { flagBtn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}}); return `reactProps:${flagBtn.getBoundingClientRect().x|0},${flagBtn.getBoundingClientRect().y|0}`; }
      flagBtn.click(); return `native:${flagBtn.getBoundingClientRect().x|0},${flagBtn.getBoundingClientRect().y|0}`;
    });
    console.log('  flag click:', flagResult);
    await wait(2000);
    await ss(page, 'P-report-modal');
    const reportBodyText = await body(page);
    console.log('  report modal body:', reportBodyText.slice(0,100).replace(/\n/g,' '));

    if (reportBodyText.includes('Report') && (reportBodyText.includes('Spam') || reportBodyText.includes('Submit'))) {
      // Select "Spam" reason
      const reasonResult = await page.evaluate(() => {
        const reasons = ['Spam','Misleading','Inappropriate','Scam','Offensive','Fake event','Harassment','Other'];
        for (const r of reasons) {
          const el = [...document.querySelectorAll('*')].find(e=>e.textContent.trim()===r&&!e.children.length);
          if (el) {
            let cur=el;
            for(let i=0;i<6;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return `selected:${r}`;}cur=cur?.parentElement;}
            el.click(); return `native:${r}`;
          }
        }
        return 'no-reason-found';
      });
      console.log('  reason selected:', reasonResult);
      await wait(600);

      // Click Submit Report
      const submitResult = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const sb = btns.find(b=>b.textContent.toLowerCase().includes('submit'));
        if (!sb) return 'no-submit-btn';
        const pk=Object.keys(sb).find(k=>k.startsWith('__reactProps$'));
        if(pk&&sb[pk]?.onClick){sb[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return 'reactProps';}
        sb.click(); return 'native';
      });
      console.log('  submit click:', submitResult);
      await wait(3000);
      await ss(page, 'P-report-submitted');
      const afterSubmit = await body(page);
      console.log('  after submit:', afterSubmit.slice(0,120).replace(/\n/g,' '));
    } else {
      console.log('  Report modal not found or no spam option');
    }

    // ---------- A3: SETTINGS - NO DUPLICATE ROLE ----------
    console.log('\n--- A3: Settings no-dup-role ---');
    await goHome(page);
    await clickTab(page, 'Profile');
    // Find settings gear icon (top-right of profile)
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const gear = btns.find(b => {
        const r = b.getBoundingClientRect();
        return r.x > 320 && r.y < 160 && b.querySelector('svg');
      });
      if (gear) gear.click();
    });
    await waitFor(page, 'ACCOUNT', 5000) || await waitFor(page, 'Account', 4000) || await waitFor(page, 'Privacy', 4000);
    await wait(800);
    await ss(page, 'P-settings-top');
    // Scroll mid-settings to show role section
    for (let i=0;i<6;i++) {
      await page.evaluate(() => {
        const els=[...document.querySelectorAll('*')].filter(e=>{const s=window.getComputedStyle(e);return(s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
        if(els[0]) els[0].scrollTop+=150;
      });
      await wait(200);
      const hasRole = await page.evaluate(() => document.body.innerText.includes('Role') || document.body.innerText.includes('role') || document.body.innerText.includes('Organizer') || document.body.innerText.includes('Attendee'));
      if (hasRole) break;
    }
    await wait(600);
    await ss(page, 'P-settings-role');
    const settingsBody = await body(page);
    console.log('  settings body (role area):', settingsBody.replace(/\n/g,' ').slice(0,200));

    // ---------- A4: USERNAME MIN 3 CHARS ----------
    console.log('\n--- A4: Username validation ---');
    // Find username field in settings
    await page.evaluate(() => window.scrollTo(0,0));
    const els = [...(await page.$$('input'))];
    // Scroll back to top of settings
    await page.evaluate(() => {
      const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
      if(s[0]) s[0].scrollTo(0,0);
    });
    await wait(500);
    // Try entering a 2-char username
    const usernameResult = await page.evaluate(() => {
      const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const inputs = [...document.querySelectorAll('input')];
      // Look for username input (placeholder or label)
      const usernameInput = inputs.find(i => i.placeholder?.toLowerCase().includes('username') || i.placeholder?.toLowerCase().includes('user')) || inputs[0];
      if (!usernameInput) return 'no-input';
      niv.call(usernameInput, 'ab'); // 2 chars - should fail
      usernameInput.dispatchEvent(new Event('input',{bubbles:true}));
      usernameInput.dispatchEvent(new Event('change',{bubbles:true}));
      usernameInput.dispatchEvent(new Event('blur',{bubbles:true}));
      return `set-to-ab-on:${usernameInput.placeholder}`;
    });
    console.log('  username input:', usernameResult);
    await wait(1000);
    await ss(page, 'P-username-min3');
    const userBodyText = (await body(page)).slice(0,300);
    console.log('  after username input:', userBodyText.replace(/\n/g,' ').slice(0,150));

    // ---------- A5: MY TICKETS ----------
    console.log('\n--- A5: My Tickets ---');
    await goHome(page);
    // dero is organizer - check for Tickets tab
    const ticketsTabInfo = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      return btns.map(b => ({ text: b.textContent.trim(), x: Math.round(b.getBoundingClientRect().x), y: Math.round(b.getBoundingClientRect().y) })).filter(b => b.y > 700);
    });
    console.log('  bottom nav tabs:', JSON.stringify(ticketsTabInfo));
    // Try clicking Tickets
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Tickets' || b.textContent.trim()==='My Tickets');
      if (btn) btn.click();
    });
    await wait(2000);
    await ss(page, 'P-my-tickets');
    const ticketsBody = (await body(page)).slice(0,200);
    console.log('  tickets body:', ticketsBody.replace(/\n/g,' ').slice(0,100));

    // ---------- A6: 3-DEEP NAVIGATION ----------
    console.log('\n--- A6: 3-deep navigation ---');
    await goHome(page);
    // 1. click event card → event detail (depth 1)
    await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter(i => {
        const r = i.getBoundingClientRect();
        return r.height > 60 && r.width > 100;
      });
      if (imgs[0]) {
        let cur = imgs[0];
        for (let i=0;i<6;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}if(window.getComputedStyle(cur||{}).cursor==='pointer'){cur.click();return;}cur=cur?.parentElement;}
        imgs[0].parentElement?.click();
      }
    });
    await waitFor(page, 'Date', 5000) || await waitFor(page, 'Time', 4000);
    await wait(1500);
    await ss(page, 'P-nav-depth1-event');
    console.log('  depth 1 (event): ok');

    // 2. click organizer name → organizer profile (depth 2)
    const orgClickResult = await page.evaluate(() => {
      // Look for organizer link - typically "By [name]" or organizer section
      const allEls = [...document.querySelectorAll('*')];
      const orgEl = allEls.find(e => {
        const t = e.textContent.trim();
        return (t.startsWith('By ') || t.startsWith('Organized by')) && !e.children.length;
      }) || allEls.find(e => e.textContent.includes('Organizer') && !e.children.length && e.textContent.length < 30);
      if (!orgEl) return 'not-found';
      let cur = orgEl;
      for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return `ok[${i}]`;}cur=cur?.parentElement;}
      orgEl.click(); return 'native';
    });
    console.log('  org click:', orgClickResult);
    await wait(2500);
    await ss(page, 'P-nav-depth2-org');
    const depth2Body = (await body(page)).slice(0,100);
    console.log('  depth 2 body:', depth2Body.replace(/\n/g,' '));

    // 3. back → event detail (depth 1)
    await goBack(page);
    await wait(1000);
    await ss(page, 'P-nav-back1');
    const back1Body = (await body(page)).slice(0,100);
    console.log('  back1 body:', back1Body.replace(/\n/g,' '));

    // 4. back → home (depth 0)
    await goBack(page);
    await wait(1000);
    await ss(page, 'P-nav-back0');
    const back0Body = (await body(page)).slice(0,80);
    console.log('  back0 body:', back0Body.replace(/\n/g,' '));

    // ---------- A7: FOLLOW / UNFOLLOW COUNTS ----------
    console.log('\n--- A7: Follow counts ---');
    await goHome(page);
    // Go to Explore → search for a user to view their profile
    await clickTab(page, 'Explore');
    await wait(1000);
    // Click People tab
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const ppl = btns.find(b => b.textContent.trim()==='People');
      if (ppl) ppl.click();
    });
    await wait(1500);
    // Click first person in list
    const personClicked = await page.evaluate(() => {
      const allEls = [...document.querySelectorAll('*')];
      // Find Follow buttons (means these are user cards)
      const followBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Follow');
      if (followBtn) {
        // Find parent card
        let cur = followBtn;
        for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick&&!cur.textContent.includes('Follow')){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return `card-click[${i}]`;}cur=cur?.parentElement;}
        // Navigate by clicking user avatar/name area
        const parentCard = followBtn.closest('[style*="cursor"]') || followBtn.parentElement?.parentElement;
        if (parentCard) { parentCard.click(); return 'card-native'; }
      }
      return 'no-follow-btn';
    });
    console.log('  person click:', personClicked);
    await wait(2000);
    await ss(page, 'P-user-profile');
    const profileBody = (await body(page)).slice(0,200);
    console.log('  user profile:', profileBody.replace(/\n/g,' ').slice(0,150));

    // ---------- A8: OWN PROFILE (NO SELF-FOLLOW) ----------
    console.log('\n--- A8: Own profile (no self-follow) ---');
    await goHome(page);
    await clickTab(page, 'Profile');
    await wait(1500);
    await ss(page, 'P-own-profile-nofollow');
    const ownProfileBody = await body(page);
    const hasFollowSelf = ownProfileBody.includes('Follow') && !ownProfileBody.includes('Following');
    console.log('  has self-follow button:', hasFollowSelf, '| body slice:', ownProfileBody.slice(0,150).replace(/\n/g,' '));

    // ---------- A9: ORGANIZER REVIEWS ----------
    console.log('\n--- A9: Organizer Reviews ---');
    await goHome(page);
    // Go to an event → tap organizer name → see reviews tab on their profile
    await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter(i => {
        const r = i.getBoundingClientRect();
        return r.height > 60 && r.width > 100;
      });
      if (imgs[0]) {
        let cur = imgs[0];
        for(let i=0;i<6;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}if(window.getComputedStyle(cur||{}).cursor==='pointer'){cur.click();return;}cur=cur?.parentElement;}
        imgs[0].parentElement?.click();
      }
    });
    await waitFor(page, 'Date', 5000) || await wait(3000);
    await wait(1000);
    // Click organizer name
    await page.evaluate(() => {
      const allEls = [...document.querySelectorAll('*')];
      const orgEl = allEls.find(e => {
        const t = e.textContent.trim();
        return (t.startsWith('By ') || t.includes('Organizer')) && !e.children.length && t.length < 40;
      });
      if (!orgEl) return;
      let cur = orgEl;
      for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}
      orgEl.click();
    });
    await wait(2500);
    // Click Reviews tab if available
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reviews');
      if (btn) btn.click();
    });
    await wait(1500);
    await ss(page, 'P-organizer-reviews');
    const revBody = (await body(page)).slice(0,200);
    console.log('  reviews body:', revBody.replace(/\n/g,' ').slice(0,150));

    // ============================================================
    // PART B: ADMIN SESSION
    // ============================================================
    console.log('\n=== B: Switch to Admin ===');
    await signOut(page);
    await wait(1500);
    const adminOk = await login(page, ROOT_EMAIL, ROOT_PASS);
    if (!adminOk) { console.log('  ADMIN LOGIN FAILED'); await ss(page, 'P-admin-login-fail'); }
    else {
      await wait(2000);
      // Go to Admin Dashboard
      await clickTab(page, 'Profile');
      for (let i=0;i<20;i++) {
        const found = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Admin Dashboard');
          if (btn) { btn.scrollIntoView({block:'center'}); return true; }
          const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
          if(s[0]) s[0].scrollTop+=80;
          return false;
        });
        if (found) break;
        await wait(150);
      }
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Admin Dashboard');
        if (btn) { const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$')); if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click(); }
      });
      await waitFor(page, 'Admin Console', 6000);
      await wait(800);
      await ss(page, 'P-admin-dashboard');

      // ---------- B1: STATS TAB (revenue + user growth) ----------
      console.log('\n--- B1: Admin Stats ---');
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Stats');
        if (btn) { const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$')); if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click(); }
      });
      await waitFor(page, 'Revenue', 8000) || await waitFor(page, 'Users', 5000) || await waitFor(page, 'Loading', 3000);
      await wait(2500); // wait for fetch
      await ss(page, 'P-admin-stats');
      const statsBody = await body(page);
      console.log('  stats body:', statsBody.replace(/\n/g,' ').slice(0,300));

      // ---------- B2: REPORTS TAB (should now have report) ----------
      console.log('\n--- B2: Admin Reports ---');
      await page.evaluate(() => {
        const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
        if(s[0]) s[0].scrollTo(0,0);
      });
      await wait(500);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reports');
        if (btn) btn.click();
      });
      await wait(2000);
      await ss(page, 'P-admin-reports');
      const repBody = await body(page);
      console.log('  reports body:', repBody.replace(/\n/g,' ').slice(0,200));

      // ---------- B3: ANNOUNCEMENT BANNER ----------
      console.log('\n--- B3: Announcement banner ---');
      // Check if there's an Announcements / banner option in admin
      const annBtnInfo = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        return btns.map(b=>b.textContent.trim()).filter(t=>t.length>0&&t.length<30);
      });
      console.log('  admin tabs:', annBtnInfo.slice(0,20));
      const hasAnn = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.includes('Announce')||b.textContent.includes('Banner')||b.textContent.includes('System'));
        if (btn) { btn.click(); return true; } return false;
      });
      if (hasAnn) {
        await wait(1500);
        await ss(page, 'P-admin-announcement');
      }

      // ---------- B4: PAYOUTS ALL TAB ----------
      console.log('\n--- B4: Payouts All tab ---');
      await page.evaluate(() => {
        const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
        if(s[0]) s[0].scrollTo(0,0);
      });
      await wait(400);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Payouts');
        if (btn) btn.click();
      });
      await wait(1500);
      // Click "All" sub-tab
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const allBtn = btns.find(b=>b.textContent.trim()==='All');
        if (allBtn) allBtn.click();
      });
      await wait(1500);
      await ss(page, 'P-admin-payouts-all');
      const payoutsBody = (await body(page)).slice(0,200);
      console.log('  payouts-all body:', payoutsBody.replace(/\n/g,' ').slice(0,100));
    }

    console.log('\n=== All screenshots done ===');
    const allFiles = fs.readdirSync(OUT).filter(f=>f.endsWith('.png')).sort();
    allFiles.forEach(f=>console.log(`  ${f}`));

  } catch(e) {
    console.error('FATAL:', e.message, e.stack?.slice(0,300));
    try { await ss(page, 'P-fatal'); } catch {}
  } finally {
    await browser.close();
  }
})();
