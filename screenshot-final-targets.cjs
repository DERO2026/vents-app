// Final targeted: 3-deep nav + organizer reviews + my tickets + admin system tab
// Key: organizer button text = "See organizer reviews"
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

// Press the ← back button at top-left of screen
async function goBack(page) {
  await page.evaluate(()=>{
    const b=[...document.querySelectorAll('button')].find(btn=>{const r=btn.getBoundingClientRect();return r.x<80&&r.y<120&&r.y>=0&&btn.querySelector('svg');});
    if(b){const pk=Object.keys(b).find(k=>k.startsWith('__reactProps$'));if(pk&&b[pk]?.onClick)b[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else b.click();}
  });
  await wait(1500);
}

// Navigate to home from any depth
async function goHome(page) {
  // Keep pressing back until we see bottom nav "Home" button and no back button
  for(let i=0;i<10;i++){
    const state=await page.evaluate(()=>{
      const hasHome=[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Home'&&b.getBoundingClientRect().y>700);
      const hasBack=[...document.querySelectorAll('button')].some(b=>{const r=b.getBoundingClientRect();return r.x<80&&r.y<120&&r.y>=0&&b.querySelector('svg');});
      return{hasHome,hasBack};
    });
    if(state.hasHome&&!state.hasBack)return;
    if(state.hasBack){await goBack(page);continue;}
    // No back button and no home - click Home tab
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Home')?.click());
    await wait(800);
    return;
  }
}

async function login(page, email, pass) {
  const loggedIn=await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>['Home','Explore','Profile'].includes(b.textContent.trim())));
  if(loggedIn)return true;
  const bl=(await body(page)).toLowerCase();
  if(bl.includes('get started')||bl.includes('discover')){await page.evaluate(()=>[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Sign in'&&!e.children.length)?.click());await wait(2000);}
  await page.evaluate((e,p)=>{const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;const fill=(el,v)=>{if(!el)return;niv.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};fill(document.querySelector('input[type="text"]'),e);fill(document.querySelector('input[type="password"]'),p);},email,pass);
  await wait(400);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign In')?.click());
  const ok=await waitFor(page,'Home',15000);
  console.log(`  login(${email}):${ok?'✓':'✗'}`);
  return ok;
}

async function signOut(page){
  await goHome(page);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
  await wait(1200);
  for(let i=0;i<15;i++){
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTop+=100;});
    await wait(100);
    const f=await page.evaluate(()=>[...document.querySelectorAll('*')].some(e=>e.textContent.trim()==='Sign Out'&&!e.children.length));
    if(f)break;
  }
  await page.evaluate(()=>{let el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Sign Out'&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
  await wait(800);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>['Sign Out','Confirm','Yes','Log Out'].includes(b.textContent.trim()))?.click());
  await waitFor(page,'Get Started',6000)||await waitFor(page,'Sign in',5000);
  console.log('  signed out');
}

// Navigate to event detail and scroll to organizer section
async function openEventDetail(page) {
  await goHome(page);
  await page.evaluate(()=>{
    const imgs=[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.height>60&&r.width>100&&r.top>50&&r.top<700;});
    if(imgs[0]){let cur=imgs[0];for(let i=0;i<6;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}if(window.getComputedStyle(cur||{}).cursor==='pointer'){cur.click();return;}cur=cur?.parentElement;}imgs[0].parentElement?.click();}
  });
  await waitFor(page,'Date',5000)||await wait(3000);
  await wait(1000);
}

(async()=>{
  const browser=await puppeteer.launch({
    headless:false,
    executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport:{width:390,height:844},
    args:['--window-size=430,900','--no-sandbox'],
    userDataDir:'C:\\Temp\\puppeteer-vents-v4',
  });
  const page=await browser.newPage();
  await page.setViewport({width:390,height:844});

  try{
    await page.goto('https://getvents.com',{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>document.querySelectorAll('button').length>0,{timeout:30000});
    await wait(4000);
    await login(page,DERO_EMAIL,DERO_PASS);
    await wait(2000);

    // ===================================================
    // 1: MY TICKETS (attendee FAB)
    // ===================================================
    console.log('\n--- 1: My Tickets ---');
    await goHome(page);
    // The Tickets FAB is the center button in bottom nav, no text but has ticket icon
    // Find it by SVG content or by position
    const ticketBtnResult=await page.evaluate(()=>{
      const btns=[...document.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect();return r.y>750&&r.y<850;});
      console.log('Bottom btns:',btns.map(b=>({text:b.textContent.trim(),x:Math.round(b.getBoundingClientRect().x)})));
      // Sort by x to find center
      const sorted=btns.sort((a,b)=>a.getBoundingClientRect().x-b.getBoundingClientRect().x);
      // The center one (index ~1 or 2 of 3-4)
      const mid=Math.floor(sorted.length/2);
      const fab=sorted[mid];
      if(!fab)return`no-fab (found ${sorted.length} bottom btns)`;
      const r=fab.getBoundingClientRect();
      const pk=Object.keys(fab).find(k=>k.startsWith('__reactProps$'));
      if(pk&&fab[pk]?.onClick){fab[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return`reactProps:x=${Math.round(r.x)}`;}
      fab.click();return`native:x=${Math.round(r.x)}`;
    });
    console.log('  FAB click:',ticketBtnResult);
    await wait(2500);
    await ss(page,'S-my-tickets');
    const myTicketsBody=(await body(page)).slice(0,200);
    console.log('  my tickets body:',myTicketsBody.replace(/\n/g,' ').slice(0,100));

    // ===================================================
    // 2: 3-DEEP NAVIGATION
    // ===================================================
    console.log('\n--- 2: 3-deep nav ---');
    await goHome(page);
    await openEventDetail(page);
    await ss(page,'S-depth1-event');
    console.log('  depth1: ok');

    // Scroll down to find "See organizer reviews" button
    let orgBtnFound=false;
    for(let i=0;i<20;i++){
      const found=await page.evaluate(()=>{
        const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='See organizer reviews'&&!e.children.length);
        return !!el;
      });
      if(found){orgBtnFound=true;break;}
      await page.evaluate(()=>{
        const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
        if(s[0])s[0].scrollBy(0,200);else window.scrollBy(0,200);
      });
      await wait(150);
    }
    console.log('  "See organizer reviews" button found:',orgBtnFound);
    await ss(page,'S-event-org-section');
    const orgSectionBody=(await body(page)).slice(0,200);
    console.log('  org section body:',orgSectionBody.replace(/\n/g,' ').slice(0,150));

    // Click "See organizer reviews" → depth 2
    const orgClickResult=await page.evaluate(()=>{
      const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='See organizer reviews'&&!e.children.length);
      if(!el)return'not-found';
      let cur=el;
      for(let i=0;i<8;i++){
        const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));
        if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return`ok[${i}]`;}
        cur=cur?.parentElement;
      }
      el.click();return'native';
    });
    console.log('  org click:',orgClickResult);
    await wait(3000);
    await ss(page,'S-depth2-org-profile');
    const depth2Body=(await body(page)).slice(0,150);
    console.log('  depth2 body:',depth2Body.replace(/\n/g,' ').slice(0,100));

    // Back to event (depth 1)
    await goBack(page);
    await wait(1000);
    await ss(page,'S-back1-to-event');
    const back1Body=(await body(page)).slice(0,80);
    console.log('  back1:',back1Body.replace(/\n/g,' ').slice(0,60));

    // Back to home (depth 0)
    await goBack(page);
    await wait(1000);
    await ss(page,'S-back2-to-home');
    const back2Body=(await body(page)).slice(0,80);
    console.log('  back2:',back2Body.replace(/\n/g,' ').slice(0,60));

    // ===================================================
    // 3: ORGANIZER REVIEWS TAB (depth 2 organizer profile)
    // ===================================================
    console.log('\n--- 3: Organizer reviews tab ---');
    await openEventDetail(page);
    // Scroll to organizer section
    for(let i=0;i<20;i++){
      const found=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
      if(found)break;
      await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollBy(0,200);else window.scrollBy(0,200);});
      await wait(150);
    }
    await page.evaluate(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='See organizer reviews'&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
    await wait(3000);
    await ss(page,'S-organizer-profile');
    // Look for Reviews tab on organizer profile
    const profileTabs=await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>t&&t.length<20&&t.length>0));
    console.log('  org profile tabs:',profileTabs.slice(0,15));
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reviews')?.click());
    await wait(1500);
    await ss(page,'S-org-reviews-tab');
    const reviewsBody=(await body(page)).slice(0,300);
    console.log('  reviews body:',reviewsBody.replace(/\n/g,' ').slice(0,200));
    // Back to event, then home
    await goBack(page);
    await wait(1000);
    await goBack(page);
    await wait(1000);

    // ===================================================
    // 4: SETTINGS - SCROLL TO DELETE ACCOUNT
    // ===================================================
    console.log('\n--- 4: Settings Delete Account ---');
    await goHome(page);
    // Profile → Settings menu item
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1200);
    // Click Settings (the menu row in Profile screen, not a button - it's a div with cursor:pointer)
    const settingsClick=await page.evaluate(()=>{
      const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Settings'&&!e.children.length);
      if(!el)return'not-found';
      let cur=el;
      for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return`ok[${i}]`;}cur=cur?.parentElement;}
      el.click();return'native';
    });
    console.log('  settings click:',settingsClick);
    await waitFor(page,'ACCOUNT',5000)||await waitFor(page,'Profile Details',4000);
    await wait(800);
    // Now in Settings screen - scroll to bottom to find Delete Account
    for(let i=0;i<25;i++){
      await page.evaluate(()=>{
        const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
        if(s[0])s[0].scrollBy(0,120);else window.scrollBy(0,120);
      });
      await wait(100);
      const hasDelete=await page.evaluate(()=>document.body.innerText.toLowerCase().includes('delete account')||document.body.innerText.toLowerCase().includes('danger zone'));
      if(hasDelete)break;
    }
    await wait(600);
    await ss(page,'S-settings-delete-account');
    const settingsDeleteBody=await body(page);
    console.log('  settings delete body:',settingsDeleteBody.replace(/\n/g,' ').slice(0,200));
    // Go back to home
    await goBack(page);
    await wait(1000);
    await goBack(page);
    await wait(1000);

    // ===================================================
    // 5: USERNAME VALIDATION (Profile Details form)
    // ===================================================
    console.log('\n--- 5: Username min 3 chars ---');
    await goHome(page);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1200);
    // Click Settings
    await page.evaluate(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Settings'&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
    await waitFor(page,'Profile Details',5000);
    await wait(800);
    // Click Profile Details
    const profileDetailsClick=await page.evaluate(()=>{
      const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Profile Details'&&!e.children.length);
      if(!el)return'not-found';
      let cur=el;
      for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return`ok[${i}]`;}cur=cur?.parentElement;}
      el.click();return'native';
    });
    console.log('  profile details click:',profileDetailsClick);
    await waitFor(page,'Username',5000)||await waitFor(page,'username',4000)||await waitFor(page,'Bio',4000)||await wait(3000);
    await wait(1000);
    await ss(page,'S-profile-details-form');
    const formBody=await body(page);
    console.log('  form body:',formBody.replace(/\n/g,' ').slice(0,200));
    // Find username input and type 2 chars
    const inputsInfo=await page.evaluate(()=>{
      const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='file'&&i.type!=='checkbox'&&i.type!=='radio'&&i.type!=='hidden');
      return inputs.map(i=>({type:i.type,placeholder:i.placeholder,id:i.id,name:i.name,value:i.value.slice(0,20)}));
    });
    console.log('  inputs:',JSON.stringify(inputsInfo));
    const usernameResult=await page.evaluate(()=>{
      const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='file'&&i.type!=='checkbox'&&i.type!=='radio'&&i.type!=='hidden');
      const usernameInput=inputs.find(i=>(i.placeholder||'').toLowerCase().includes('user'))||(inputs.find(i=>(i.name||'').toLowerCase().includes('user')))||inputs.find(i=>i.type==='text')||inputs[0];
      if(!usernameInput)return`no-input (found ${inputs.length})`;
      niv.call(usernameInput,'ab');
      usernameInput.dispatchEvent(new Event('input',{bubbles:true}));
      usernameInput.dispatchEvent(new Event('change',{bubbles:true}));
      usernameInput.dispatchEvent(new Event('blur',{bubbles:true}));
      return`set-to-ab on "${usernameInput.placeholder||usernameInput.id}"`;
    });
    console.log('  username result:',usernameResult);
    await wait(1500);
    await ss(page,'S-username-2chars-validation');
    const validationBody=await body(page);
    console.log('  validation body:',validationBody.replace(/\n/g,' ').slice(0,200));
    // Back to home
    await goBack(page);await wait(500);await goBack(page);await wait(500);await goBack(page);await wait(500);await goBack(page);

    // ===================================================
    // 6: ADMIN - SYSTEM TAB (announcement banner)
    // ===================================================
    console.log('\n=== Switch to Admin ===');
    await signOut(page);
    await wait(1500);
    const adminOk=await login(page,ROOT_EMAIL,ROOT_PASS);
    if(!adminOk){console.log('  ADMIN FAILED');await browser.close();return;}
    await wait(2000);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1500);
    for(let i=0;i<20;i++){const found=await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Admin Dashboard');if(btn){btn.scrollIntoView({block:'center'});return true;}const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTop+=80;return false;});if(found)break;await wait(150);}
    await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Admin Dashboard');if(btn){const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$'));if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click();}});
    await waitFor(page,'Admin Console',6000);
    await wait(800);

    // Click System tab
    console.log('\n--- Admin System tab ---');
    await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='System');if(btn){const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$'));if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click();}});
    await waitFor(page,'Banner',5000)||await waitFor(page,'Announce',5000)||await waitFor(page,'System',3000)||await wait(2000);
    await wait(1000);
    await ss(page,'S-admin-system-tab');
    const sysBody=await body(page);
    console.log('  system body:',sysBody.replace(/\n/g,' ').slice(0,400));
    // Scroll to see full system tab
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollBy(0,300);});
    await wait(1000);
    await ss(page,'S-admin-system-scrolled');

    console.log('\n=== DONE ===');
  }catch(e){
    console.error('FATAL:',e.message,e.stack?.slice(0,200));
    try{await ss(page,'S-fatal');}catch{}
  }finally{
    await browser.close();
  }
})();
