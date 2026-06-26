// Remaining screenshots: admin stats, admin reports, username validation,
// my tickets, 3-deep nav, follow counts, organizer reviews, nav back button
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
        const r = b.getBoundingClientRect(); return r.x < 60 && r.y < 100 && b.querySelector('svg');
      });
      return hasNav && !hasBack;
    });
    if (onHome) return;
    await goBack(page);
  }
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Home')?.click());
  await wait(800);
}

async function login(page, email, pass) {
  const loggedIn = await page.evaluate(() => [...document.querySelectorAll('button')].some(b=>['Home','Explore','Profile'].includes(b.textContent.trim())));
  if (loggedIn) return true;
  const bl = (await body(page)).toLowerCase();
  if (bl.includes('get started')||bl.includes('discover')) {
    await page.evaluate(()=>[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Sign in'&&!e.children.length)?.click());
    await wait(2000);
  }
  await page.evaluate((e,p)=>{
    const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    const fill=(el,v)=>{if(!el)return;niv.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    fill(document.querySelector('input[type="text"]'),e);
    fill(document.querySelector('input[type="password"]'),p);
  }, email, pass);
  await wait(400);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign In')?.click());
  const ok = await waitFor(page,'Home',15000);
  console.log(`  login(${email}): ${ok?'✓':'✗'}`);
  return ok;
}

async function signOut(page) {
  await goHome(page);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
  await wait(1200);
  for (let i=0;i<15;i++) {
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTop+=100;});
    await wait(100);
    const found = await page.evaluate(()=>[...document.querySelectorAll('*')].some(e=>e.textContent.trim()==='Sign Out'&&!e.children.length));
    if (found) break;
  }
  await page.evaluate(()=>{let el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Sign Out'&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
  await wait(800);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>['Sign Out','Confirm','Yes','Log Out'].includes(b.textContent.trim()))?.click());
  await waitFor(page,'Get Started',6000)||await waitFor(page,'Sign in',5000);
  console.log('  signed out');
}

(async ()=>{
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
    await page.goto('https://getvents.com',{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>document.querySelectorAll('button').length>0,{timeout:30000});
    await wait(4000);

    // ============================================================
    // DERO SESSION
    // ============================================================
    await login(page, DERO_EMAIL, DERO_PASS);
    await wait(2000);

    // ---------- 1: MY TICKETS (dero = organizer) ----------
    console.log('\n--- 1: My Tickets ---');
    await goHome(page);
    const bottomNavBtns = await page.evaluate(()=>[...document.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().y>700).map(b=>b.textContent.trim()));
    console.log('  bottom nav:', bottomNavBtns);
    // Click Tickets
    await page.evaluate(()=>{
      const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Tickets'||b.textContent.trim()==='My Tickets');
      if(btn){const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$'));if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click();}
    });
    await wait(2500);
    await ss(page,'Q-my-tickets');
    const ticketsBody = (await body(page)).slice(0,200);
    console.log('  tickets body:', ticketsBody.replace(/\n/g,' ').slice(0,150));
    // Check for back button
    const hasBackOnTickets = await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>{const r=b.getBoundingClientRect();return r.x<60&&r.y<100&&b.querySelector('svg');}));
    console.log('  has back button on tickets:', hasBackOnTickets);
    if (hasBackOnTickets) {
      await ss(page,'Q-my-tickets-with-back');
      await goBack(page);
      await ss(page,'Q-after-tickets-back');
    }

    // ---------- 2: 3-DEEP NAVIGATION ----------
    console.log('\n--- 2: 3-deep navigation ---');
    await goHome(page);
    // Depth 1: click event card
    await page.evaluate(()=>{
      const imgs=[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.height>60&&r.width>100&&r.top>50&&r.top<700;});
      if(imgs[0]){let cur=imgs[0];for(let i=0;i<6;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}if(window.getComputedStyle(cur||{}).cursor==='pointer'){cur.click();return;}cur=cur?.parentElement;}imgs[0].parentElement?.click();}
    });
    await waitFor(page,'Date',5000)||await wait(3000);
    await wait(1000);
    await ss(page,'Q-nav1-event');
    const eventTitle = (await body(page)).slice(0,50).replace(/\n/g,' ');
    console.log('  depth1:', eventTitle);

    // Depth 2: click organizer
    const orgResult = await page.evaluate(()=>{
      // Look for organizer/creator link
      const allEls=[...document.querySelectorAll('*')];
      // Try "By [name]" text
      let el = allEls.find(e=>{
        const t=e.textContent.trim();
        return t.startsWith('By ')&&!e.children.length&&t.length<60;
      });
      if (!el) {
        // Try button/link with "Organized by" or organizer avatar area
        el = allEls.find(e=>{
          const t=e.textContent.trim();
          return (t.includes('Organized')||t.includes('organizer'))&&!e.children.length&&t.length<50;
        });
      }
      if (!el) return 'not-found';
      let cur=el;
      for(let i=0;i<10;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return `depth2-ok[${i}]`;}cur=cur?.parentElement;}
      el.click(); return 'depth2-native';
    });
    console.log('  org click:', orgResult);
    await wait(2500);
    const depth2Body = (await body(page)).slice(0,100);
    console.log('  depth2 body:', depth2Body.replace(/\n/g,' '));
    await ss(page,'Q-nav2-org');

    // Back to event detail
    await goBack(page);
    await wait(1000);
    const afterBack1 = (await body(page)).slice(0,60).replace(/\n/g,' ');
    console.log('  after back1:', afterBack1);
    await ss(page,'Q-nav-back1');

    // Back to home
    await goBack(page);
    await wait(1000);
    const afterBack2 = (await body(page)).slice(0,60).replace(/\n/g,' ');
    console.log('  after back2:', afterBack2);
    await ss(page,'Q-nav-back2');

    // ---------- 3: USERNAME MIN 3 CHARS (in Settings) ----------
    console.log('\n--- 3: Username validation ---');
    await goHome(page);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1200);
    // Find and click Settings gear (top-right button in profile header)
    await page.evaluate(()=>{
      const btns=[...document.querySelectorAll('button')];
      const gear=btns.find(b=>{const r=b.getBoundingClientRect();return r.x>320&&r.y<160&&b.querySelector('svg');});
      if(gear)gear.click();
    });
    await waitFor(page,'ACCOUNT',5000)||await waitFor(page,'Account',4000)||await waitFor(page,'Username',4000);
    await wait(800);
    await ss(page,'Q-settings-open');
    // Find username text input (not file input)
    const usernameInputResult = await page.evaluate(()=>{
      const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='file'&&i.type!=='checkbox'&&i.type!=='radio');
      // Find by placeholder
      const usernameInput=inputs.find(i=>i.placeholder?.toLowerCase().includes('username'))||
                          inputs.find(i=>i.placeholder?.toLowerCase().includes('user'))||
                          inputs.find(i=>i.type==='text');
      if(!usernameInput) return `no-text-input (found ${inputs.length} inputs total, types: ${inputs.map(i=>i.type+':'+i.placeholder).join(', ')})`;
      // Check current value
      const currentVal = usernameInput.value;
      // Set to 2 chars
      niv.call(usernameInput,'ab');
      usernameInput.dispatchEvent(new Event('input',{bubbles:true}));
      usernameInput.dispatchEvent(new Event('change',{bubbles:true}));
      usernameInput.dispatchEvent(new Event('blur',{bubbles:true}));
      return `set-2chars on placeholder="${usernameInput.placeholder}" was="${currentVal}"`;
    });
    console.log('  username input:', usernameInputResult);
    await wait(1200);
    await ss(page,'Q-username-2chars');
    const userValidBody = (await body(page)).slice(0,300);
    console.log('  validation body:', userValidBody.replace(/\n/g,' ').slice(0,200));

    // ---------- 4: FOLLOW / UNFOLLOW COUNTS ----------
    console.log('\n--- 4: Follow counts ---');
    await goHome(page);
    // Go to Explore → People
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Explore')?.click());
    await wait(1500);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='People')?.click());
    await wait(1500);
    await ss(page,'Q-explore-people');
    // Click first person
    const clickedPerson = await page.evaluate(()=>{
      const allEls=[...document.querySelectorAll('*')];
      // Find user card - has Follow button or avatar
      const followBtn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Follow'||b.textContent.trim()==='Following');
      if(followBtn){
        // Walk up to find card
        let cur=followBtn.parentElement?.parentElement?.parentElement;
        if(cur){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return 'card-via-reactProps';}}
        // Try clicking name near follow button
        const parent=followBtn.closest('[style*="cursor"]')||followBtn.parentElement;
        if(parent){parent.click();return 'card-native';}
      }
      // Try first clickable item in people list
      const items=allEls.filter(e=>{
        const r=e.getBoundingClientRect();
        const cs=window.getComputedStyle(e);
        return cs.cursor==='pointer'&&r.height>40&&r.width>200&&r.top>100&&r.top<700;
      });
      if(items[0]){items[0].click();return 'first-clickable';}
      return 'not-found';
    });
    console.log('  person clicked:', clickedPerson);
    await wait(2500);
    await ss(page,'Q-other-user-profile');
    const otherProfileBody = (await body(page)).slice(0,200);
    console.log('  other profile:', otherProfileBody.replace(/\n/g,' ').slice(0,150));

    // ---------- 5: ORGANIZER REVIEWS ----------
    console.log('\n--- 5: Organizer reviews ---');
    await goHome(page);
    // Navigate to event → click organizer name → Reviews tab
    await page.evaluate(()=>{
      const imgs=[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.height>60&&r.width>100&&r.top>50;});
      if(imgs[0]){let cur=imgs[0];for(let i=0;i<6;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}if(window.getComputedStyle(cur||{}).cursor==='pointer'){cur.click();return;}cur=cur?.parentElement;}imgs[0].parentElement?.click();}
    });
    await waitFor(page,'Date',5000)||await wait(3000);
    await wait(1000);
    // Click organizer
    await page.evaluate(()=>{
      const allEls=[...document.querySelectorAll('*')];
      let el=allEls.find(e=>{const t=e.textContent.trim();return t.startsWith('By ')&&!e.children.length&&t.length<60;});
      if(!el)el=allEls.find(e=>{const t=e.textContent.trim();return(t.includes('rganiz')&&t.length<50)&&!e.children.length;});
      if(!el)return;
      let cur=el;
      for(let i=0;i<10;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}
      el.click();
    });
    await wait(2500);
    const orgProfileBody=(await body(page)).slice(0,100);
    console.log('  org profile:', orgProfileBody.replace(/\n/g,' ').slice(0,80));
    // Check for Reviews tab
    const reviewTabInfo=await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>t.length>0&&t.length<20));
    console.log('  org profile tabs/btns:', reviewTabInfo.slice(0,15));
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reviews')?.click());
    await wait(1500);
    await ss(page,'Q-org-reviews-tab');
    const reviewsBody=(await body(page)).slice(0,300);
    console.log('  reviews tab body:', reviewsBody.replace(/\n/g,' ').slice(0,200));
    // Check Write a Review button visibility (only for paid ticket holders)
    const writeReviewVisible=reviewsBody.includes('Write a Review')||reviewsBody.includes('Write Review');
    console.log('  write review visible:', writeReviewVisible);

    // ============================================================
    // ADMIN SESSION
    // ============================================================
    console.log('\n=== Switch to Admin ===');
    await signOut(page);
    await wait(1500);
    const adminOk=await login(page,ROOT_EMAIL,ROOT_PASS);
    if(!adminOk){console.log('  ADMIN LOGIN FAILED');await ss(page,'Q-admin-fail');await browser.close();return;}
    await wait(2000);

    // Navigate to Admin Dashboard
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1500);
    for(let i=0;i<20;i++){
      const found=await page.evaluate(()=>{
        const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Admin Dashboard');
        if(btn){btn.scrollIntoView({block:'center'});return true;}
        const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
        if(s[0])s[0].scrollTop+=80;return false;
      });
      if(found)break;
      await wait(150);
    }
    await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Admin Dashboard');if(btn){const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$'));if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click();}});
    await waitFor(page,'Admin Console',6000);
    await wait(800);
    await ss(page,'Q-admin-dashboard');

    // ---------- ADMIN STATS TAB ----------
    console.log('\n--- Admin Stats ---');
    await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Stats');if(btn){const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$'));if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click();}});
    await waitFor(page,'Revenue',8000)||await waitFor(page,'Total Users',6000)||await waitFor(page,'New This',5000)||await wait(4000);
    await wait(1500);
    await ss(page,'Q-admin-stats');
    const statsBody=await body(page);
    console.log('  stats body:', statsBody.replace(/\n/g,' ').slice(0,300));

    // ---------- ADMIN REPORTS TAB (should show submitted report) ----------
    console.log('\n--- Admin Reports (with submitted report) ---');
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTo(0,0);});
    await wait(300);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reports')?.click());
    await wait(2500);
    await ss(page,'Q-admin-reports-with-data');
    const reportsBody=await body(page);
    console.log('  reports body:', reportsBody.replace(/\n/g,' ').slice(0,300));

    // ---------- ADMIN PAYOUTS (All sub-tab) ----------
    console.log('\n--- Admin Payouts All tab ---');
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTo(0,0);});
    await wait(300);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Payouts')?.click());
    await wait(1500);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='All')?.click());
    await wait(1500);
    await ss(page,'Q-admin-payouts-all');

    // ---------- ANNOUNCEMENT BANNER ----------
    console.log('\n--- Announcement banner ---');
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTo(0,0);});
    await wait(300);
    const adminTabsAll=await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>t&&t.length<25));
    console.log('  all admin buttons:', adminTabsAll.slice(0,20));
    const sysBtn=await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('System')||b.textContent.includes('Announce')||b.textContent.includes('Banner')||b.textContent.includes('Notif')));
    if(sysBtn){
      await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('System')||b.textContent.includes('Announce'));if(btn)btn.click();});
      await wait(1500);
      await ss(page,'Q-admin-system');
    }
    // Scroll to see announcement in overview
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTo(0,0);});
    await wait(400);
    // Click Users tab first
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Users')?.click());
    await wait(1200);
    // Scroll down in admin to see any announcement card
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollBy(0,500);});
    await wait(800);
    await ss(page,'Q-admin-users-scrolled');
    const announcementInBody=(await body(page)).includes('Announce')||(await body(page)).includes('Banner')||(await body(page)).includes('announcement');
    console.log('  announcement in body:', announcementInBody);

    console.log('\n=== DONE ===');
    const allFiles=fs.readdirSync(OUT).filter(f=>f.endsWith('.png')&&f.startsWith('Q-')).sort();
    allFiles.forEach(f=>console.log(`  ${f}`));

  } catch(e) {
    console.error('FATAL:',e.message,e.stack?.slice(0,200));
    try{await ss(page,'Q-fatal');}catch{}
  } finally {
    await browser.close();
  }
})();
