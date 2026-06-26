// Final targeted: Settings delete-account, username validation, My Tickets,
// 3-deep nav, organizer reviews, System tab, admin announcement
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
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(btn=>{const r=btn.getBoundingClientRect();return r.x<60&&r.y<100&&btn.querySelector('svg');});if(b)b.click();});
  await wait(1200);
}
async function goHome(page) {
  for(let i=0;i<8;i++){
    const onHome=await page.evaluate(()=>{const hasNav=[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Home');const hasBack=[...document.querySelectorAll('button')].some(b=>{const r=b.getBoundingClientRect();return r.x<60&&r.y<100&&b.querySelector('svg');});return hasNav&&!hasBack;});
    if(onHome)return;
    await goBack(page);
  }
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Home')?.click());
  await wait(800);
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
  for(let i=0;i<15;i++){await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTop+=100;});await wait(100);const f=await page.evaluate(()=>[...document.querySelectorAll('*')].some(e=>e.textContent.trim()==='Sign Out'&&!e.children.length));if(f)break;}
  await page.evaluate(()=>{let el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Sign Out'&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
  await wait(800);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>['Sign Out','Confirm','Yes','Log Out'].includes(b.textContent.trim()))?.click());
  await waitFor(page,'Get Started',6000)||await waitFor(page,'Sign in',5000);
  console.log('  signed out');
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

    // ---------- 1: SETTINGS - DELETE ACCOUNT ----------
    console.log('\n--- 1: Settings → Delete Account ---');
    await goHome(page);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1200);
    // Click Settings menu item
    const settingsClicked=await page.evaluate(()=>{
      const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Settings'&&!e.children.length);
      if(!el)return 'not-found';
      let cur=el;
      for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return`ok[${i}]`;}cur=cur?.parentElement;}
      el.click();return'native';
    });
    console.log('  settings click:',settingsClicked);
    await waitFor(page,'ACCOUNT',5000)||await waitFor(page,'Account',4000)||await waitFor(page,'Username',4000)||await waitFor(page,'Profile',3000);
    await wait(800);
    await ss(page,'R-settings-account');
    // Scroll to find Delete Account button
    for(let i=0;i<20;i++){
      await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTop+=100;else window.scrollBy(0,100);});
      await wait(100);
      const hasDelete=await page.evaluate(()=>document.body.innerText.includes('Delete Account')||document.body.innerText.includes('Delete account')||document.body.innerText.includes('Danger Zone'));
      if(hasDelete)break;
    }
    await wait(600);
    await ss(page,'R-settings-delete-account');
    const settingsBody=await body(page);
    console.log('  settings body (delete area):',settingsBody.replace(/\n/g,' ').slice(0,200));

    // ---------- 2: USERNAME VALIDATION ----------
    console.log('\n--- 2: Username min 3 chars ---');
    // In settings, find Edit Profile or username field
    // Scroll back to top first
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTo(0,0);});
    await wait(400);
    // Find username input in settings
    const usernameInfo=await page.evaluate(()=>{
      const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='file'&&i.type!=='checkbox'&&i.type!=='radio'&&i.type!=='hidden');
      return inputs.map(i=>({type:i.type,placeholder:i.placeholder,id:i.id,name:i.name,value:i.value.slice(0,20)}));
    });
    console.log('  inputs found:',JSON.stringify(usernameInfo));
    const usernameResult=await page.evaluate(()=>{
      const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='file'&&i.type!=='checkbox'&&i.type!=='radio'&&i.type!=='hidden');
      // Find username by placeholder or name
      const usernameInput=inputs.find(i=>(i.placeholder||'').toLowerCase().includes('user')||(i.name||'').toLowerCase().includes('user'))||inputs.find(i=>i.type==='text')||inputs[0];
      if(!usernameInput)return'no-input';
      niv.call(usernameInput,'ab');
      usernameInput.dispatchEvent(new Event('input',{bubbles:true}));
      usernameInput.dispatchEvent(new Event('change',{bubbles:true}));
      usernameInput.dispatchEvent(new Event('blur',{bubbles:true}));
      return`set-to-ab on placeholder="${usernameInput.placeholder}"`;
    });
    console.log('  username result:',usernameResult);
    await wait(1200);
    await ss(page,'R-username-validation');

    // ---------- 3: MY TICKETS VIA REACT PROPS ----------
    console.log('\n--- 3: My Tickets ---');
    await goHome(page);
    // Find the center FAB button in bottom nav by position
    const fabInfo=await page.evaluate(()=>{
      const btns=[...document.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().y>700);
      return btns.map(b=>{const r=b.getBoundingClientRect();return{text:b.textContent.trim(),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),hasSvg:!!b.querySelector('svg')};});
    });
    console.log('  bottom nav buttons:',JSON.stringify(fabInfo));
    // Click the center FAB (Tickets) by reactProps
    const fabClick=await page.evaluate(()=>{
      const btns=[...document.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().y>700);
      // Center button (FAB) - find the one in the middle
      const sorted=btns.sort((a,b)=>a.getBoundingClientRect().x-b.getBoundingClientRect().x);
      const center=sorted[Math.floor(sorted.length/2)];
      if(!center)return'no-center';
      const pk=Object.keys(center).find(k=>k.startsWith('__reactProps$'));
      if(pk&&center[pk]?.onClick){center[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return`reactProps:${Math.round(center.getBoundingClientRect().x)}`;}
      center.click();return`native:${Math.round(center.getBoundingClientRect().x)}`;
    });
    console.log('  FAB click:',fabClick);
    await wait(2500);
    await ss(page,'R-my-tickets');
    const ticketsBody=(await body(page)).slice(0,200);
    console.log('  my tickets body:',ticketsBody.replace(/\n/g,' ').slice(0,150));
    const hasBack=await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>{const r=b.getBoundingClientRect();return r.x<60&&r.y<100&&b.querySelector('svg');}));
    console.log('  has back button:',hasBack);

    // ---------- 4: 3-DEEP NAVIGATION ----------
    console.log('\n--- 4: 3-deep nav ---');
    await goHome(page);
    // Depth 1: click first event card
    await page.evaluate(()=>{
      const imgs=[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.height>60&&r.width>100&&r.top>50&&r.top<700;});
      if(imgs[0]){let cur=imgs[0];for(let i=0;i<6;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}if(window.getComputedStyle(cur||{}).cursor==='pointer'){cur.click();return;}cur=cur?.parentElement;}imgs[0].parentElement?.click();}
    });
    await waitFor(page,'Date',5000)||await wait(3000);
    await wait(1000);
    await ss(page,'R-depth1-event');
    console.log('  depth 1: ok');

    // Scroll down in event detail to find organizer section
    for(let i=0;i<8;i++){
      await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollBy(0,150);else window.scrollBy(0,150);});
      await wait(150);
      const hasOrg=await page.evaluate(()=>document.body.innerText.includes('Organizer')||document.body.innerText.includes('organizer')||document.body.innerText.includes('Hosted by')||document.body.innerText.includes('By '));
      if(hasOrg)break;
    }
    await wait(500);
    await ss(page,'R-event-organizer-section');
    const eventBody2=(await body(page)).slice(0,300);
    console.log('  event scrolled body:',eventBody2.replace(/\n/g,' ').slice(0,200));
    // Find all clickable elements in organizer area
    const orgElements=await page.evaluate(()=>{
      const allEls=[...document.querySelectorAll('*')];
      return allEls
        .filter(e=>{
          const t=e.textContent.trim();
          const r=e.getBoundingClientRect();
          return (t.includes('VENTS')||t.includes('Organizer')||t.includes('organizer')||t.includes('Hosted')||t.includes('@'))&&
                 !e.children.length&&t.length<50&&r.width>0&&r.height>0;
        })
        .slice(0,10)
        .map(e=>{
          const pk=Object.keys(e).find(k=>k.startsWith('__reactProps$'));
          const r=e.getBoundingClientRect();
          return{text:e.textContent.trim().slice(0,30),x:Math.round(r.x),y:Math.round(r.y),hasClick:!!(pk&&e[pk]?.onClick)};
        });
    });
    console.log('  organizer elements:',JSON.stringify(orgElements));

    // Click organizer
    const depth2Result=await page.evaluate(()=>{
      const allEls=[...document.querySelectorAll('*')];
      // Find clickable organizer elements
      const targets=[
        ...allEls.filter(e=>{const t=e.textContent.trim();return t.includes('@')&&!e.children.length&&t.length<30;}),
        ...allEls.filter(e=>{const t=e.textContent.trim();return (t.includes('VENTS')||t.includes('vents'))&&!e.children.length&&t.length<20;}),
        ...allEls.filter(e=>{const t=e.textContent.trim();return t.includes('Organizer')&&!e.children.length&&t.length<30;}),
      ];
      for(const el of targets){
        let cur=el;
        for(let i=0;i<10;i++){
          const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));
          if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return`ok:${el.textContent.trim().slice(0,20)}[depth=${i}]`;}
          cur=cur?.parentElement;
        }
      }
      return'not-found';
    });
    console.log('  depth2 click:',depth2Result);
    await wait(2500);
    await ss(page,'R-depth2-org');
    const depth2Body=(await body(page)).slice(0,100);
    console.log('  depth2 body:',depth2Body.replace(/\n/g,' ').slice(0,80));

    // Back to event
    await goBack(page);
    await wait(1000);
    await ss(page,'R-back-to-event');
    const backEventBody=(await body(page)).slice(0,60);
    console.log('  back to event:',backEventBody.replace(/\n/g,' '));

    // Back to home
    await goBack(page);
    await wait(1000);
    await ss(page,'R-back-to-home');
    const backHomeBody=(await body(page)).slice(0,60);
    console.log('  back to home:',backHomeBody.replace(/\n/g,' '));

    // ---------- 5: ORGANIZER REVIEWS ----------
    console.log('\n--- 5: Organizer Reviews ---');
    // Go to Explore → People → click VENTS → Reviews tab
    await goHome(page);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Explore')?.click());
    await wait(1200);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='People')?.click());
    await wait(1500);
    // Find and click VENTS account
    const ventstClick=await page.evaluate(()=>{
      const allEls=[...document.querySelectorAll('*')];
      const ventstEl=allEls.find(e=>e.textContent.trim()==='VENTS'&&!e.children.length)||
                     allEls.find(e=>e.textContent.trim()==='@vents'&&!e.children.length);
      if(!ventstEl)return'not-found';
      let cur=ventstEl;
      for(let i=0;i<10;i++){
        const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));
        if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return`ok[${i}]`;}
        if(window.getComputedStyle(cur||{}).cursor==='pointer'){cur.click();return`cursor-click[${i}]`;}
        cur=cur?.parentElement;
      }
      ventstEl.click();return'native';
    });
    console.log('  VENTS click:',ventstClick);
    await wait(2500);
    const orgBody=(await body(page)).slice(0,100);
    console.log('  org profile body:',orgBody.replace(/\n/g,' ').slice(0,80));
    // Look for Reviews tab
    const tabsList=await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>t&&t.length<20));
    console.log('  tabs:',tabsList.slice(0,15));
    // Click Reviews or Events or About tabs
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reviews')?.click());
    await wait(1500);
    await ss(page,'R-org-reviews');
    const revBody=(await body(page)).slice(0,300);
    console.log('  reviews body:',revBody.replace(/\n/g,' ').slice(0,200));
    // Take screenshot of the full profile with tabs visible
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTo(0,0);});
    await wait(600);
    await ss(page,'R-org-profile-top');

    // ============================================================
    // ADMIN SESSION → System tab
    // ============================================================
    console.log('\n=== Switch to Admin ===');
    await signOut(page);
    await wait(1500);
    const adminOk=await login(page,ROOT_EMAIL,ROOT_PASS);
    if(!adminOk){console.log('  ADMIN LOGIN FAILED');await browser.close();return;}
    await wait(2000);
    // Navigate to Admin Dashboard
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1500);
    for(let i=0;i<20;i++){
      const found=await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Admin Dashboard');if(btn){btn.scrollIntoView({block:'center'});return true;}const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollTop+=80;return false;});
      if(found)break;
      await wait(150);
    }
    await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Admin Dashboard');if(btn){const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$'));if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click();}});
    await waitFor(page,'Admin Console',6000);
    await wait(800);

    // ---------- SYSTEM TAB ----------
    console.log('\n--- System tab (announcement) ---');
    await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='System');if(btn){const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$'));if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click();}});
    await wait(2000);
    await ss(page,'R-admin-system');
    const sysBody=await body(page);
    console.log('  system body:',sysBody.replace(/\n/g,' ').slice(0,300));
    // Scroll to see full system tab
    await page.evaluate(()=>{const s=[...document.querySelectorAll('*')].filter(e=>{const cs=window.getComputedStyle(e);return(cs.overflowY==='auto'||cs.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);if(s[0])s[0].scrollBy(0,200);});
    await wait(800);
    await ss(page,'R-admin-system-scrolled');

    console.log('\n=== DONE ===');
  } catch(e){
    console.error('FATAL:',e.message,e.stack?.slice(0,200));
    try{await ss(page,'R-fatal');}catch{}
  } finally {
    await browser.close();
  }
})();
