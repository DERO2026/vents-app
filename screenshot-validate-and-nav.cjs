// Username validation error + event detail 3-deep nav
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'screenshots');

const DERO_EMAIL = 'djjackson361@gmail.com';
const DERO_PASS  = 'Dero2026$';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function ss(page, name) { await wait(2000); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log(`  ✓ ${name}.png`); }
async function waitFor(page, text, ms=8000) { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } }
async function body(page) { return page.evaluate(() => document.body.innerText); }
async function goBack(page) {
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(btn=>{const r=btn.getBoundingClientRect();return r.x<80&&r.y<120&&r.y>=0&&btn.querySelector('svg');});if(b){const pk=Object.keys(b).find(k=>k.startsWith('__reactProps$'));if(pk&&b[pk]?.onClick)b[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else b.click();}});
  await wait(1500);
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
    // Fresh start - navigate fresh so cached session doesn't have old state
    await page.goto('https://getvents.com',{waitUntil:'domcontentloaded',timeout:60000});
    await wait(5000);

    // Check if logged in
    const isLoggedIn=await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>['Home','Explore','Profile'].includes(b.textContent.trim())));
    console.log('  logged in:',isLoggedIn);
    if(!isLoggedIn){
      const bl=(await body(page)).toLowerCase();
      if(bl.includes('get started')||bl.includes('discover')){await page.evaluate(()=>[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Sign in'&&!e.children.length)?.click());await wait(2000);}
      await page.evaluate((e,p)=>{const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;const fill=(el,v)=>{if(!el)return;niv.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};fill(document.querySelector('input[type="text"]'),e);fill(document.querySelector('input[type="password"]'),p);},DERO_EMAIL,DERO_PASS);
      await wait(400);
      await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign In')?.click());
      await waitFor(page,'Home',15000);
    }
    await wait(2000);

    // Confirm on Home
    const onHome=await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Home'&&b.getBoundingClientRect().y>700));
    console.log('  on home with nav:',onHome);
    await ss(page,'U-home');

    // ===================================================
    // 1: USERNAME VALIDATION ERROR (3-char check now added)
    // ===================================================
    console.log('\n--- 1: Username validation ---');
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profile')?.click());
    await wait(1500);
    await page.evaluate(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Settings'&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
    await waitFor(page,'Profile Details',5000);
    await wait(600);
    await page.evaluate(()=>{const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Profile Details'&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
    await waitFor(page,'Username',5000)||await wait(3000);
    await wait(1500);
    // Set username to 'xy' (2 chars)
    await page.evaluate(()=>{
      const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='file'&&i.type!=='checkbox'&&i.type!=='radio'&&i.type!=='hidden');
      const u=inputs[1];
      if(!u)return;
      niv.call(u,'xy');
      u.dispatchEvent(new Event('input',{bubbles:true}));
      u.dispatchEvent(new Event('change',{bubbles:true}));
      u.dispatchEvent(new Event('blur',{bubbles:true}));
    });
    await wait(800);
    // Click Save
    await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Save'));if(!btn)return;const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$'));if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click();});
    await wait(2000);
    await ss(page,'U-username-min3-error');
    const errBody=await body(page);
    console.log('  error body:',errBody.replace(/\n/g,' ').slice(0,200));
    // Reset username to dero
    await page.evaluate(()=>{
      const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='file'&&i.type!=='checkbox'&&i.type!=='radio'&&i.type!=='hidden');
      const u=inputs[1];
      if(!u)return;
      niv.call(u,'dero');
      u.dispatchEvent(new Event('input',{bubbles:true}));
      u.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await wait(500);
    await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Save'));if(!btn)return;const pk=Object.keys(btn).find(k=>k.startsWith('__reactProps$'));if(pk&&btn[pk]?.onClick)btn[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else btn.click();});
    await wait(2000);
    console.log('  restored username to dero');
    // Back to home
    await goBack(page);await wait(500);await goBack(page);await wait(500);await goBack(page);await wait(500);
    // Click home tab
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Home')?.click());
    await waitFor(page,'Featured',5000)||await wait(2000);
    await wait(1500);

    // ===================================================
    // 2: EVENT DETAIL + 3-DEEP NAV
    // ===================================================
    console.log('\n--- 2: Event → 3-deep nav ---');
    const homeCheck=await body(page);
    console.log('  home check:',homeCheck.replace(/\n/g,' ').slice(0,80));
    // Click first event card - use mouse click on a position that should be the event card
    const cardInfo=await page.evaluate(()=>{
      const imgs=[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.height>100&&r.width>200&&r.top>50&&r.top<700;});
      if(!imgs[0])return null;
      const r=imgs[0].getBoundingClientRect();
      return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
    });
    console.log('  card:',cardInfo);
    if(!cardInfo){await ss(page,'U-no-card');await browser.close();return;}
    await page.mouse.click(cardInfo.x,cardInfo.y);
    const gotEvent=await waitFor(page,'Book',8000)||await waitFor(page,'Date',6000)||await waitFor(page,'attending',5000);
    await wait(1500);
    await ss(page,'U-event-detail');
    const evBody=await body(page);
    console.log('  event body:',evBody.replace(/\n/g,' ').slice(0,100));
    if(!evBody.includes('Book')&&!evBody.includes('Date')&&!evBody.includes('attending')){
      console.log('  NOT on event detail - skipping');
      await browser.close(); return;
    }
    // Scroll to organizer section
    for(let i=0;i<30;i++){
      const found=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
      if(found){console.log('  found org section at scroll',i);break;}
      await page.evaluate(()=>{
        // Find the main scrollable event detail container
        const els=[...document.querySelectorAll('div')].filter(e=>{
          const r=e.getBoundingClientRect();
          const cs=window.getComputedStyle(e);
          return r.width>300&&r.height>300&&r.height<window.innerHeight&&
                 (cs.overflowY==='auto'||cs.overflowY==='scroll');
        }).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);
        if(els[0]){els[0].scrollBy(0,200);}else{window.scrollBy(0,200);}
      });
      await wait(150);
    }
    const hasOrgReviews=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
    console.log('  has org reviews btn:',hasOrgReviews);
    await ss(page,'U-event-scroll-org');
    // Click it
    if(hasOrgReviews){
      await page.evaluate(()=>{
        const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='See organizer reviews'&&!e.children.length);
        if(!el)return;
        let cur=el;
        for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}
        el.click();
      });
      await wait(3000);
      await ss(page,'U-depth2-org');
      const d2=await body(page);
      console.log('  depth2:',d2.replace(/\n/g,' ').slice(0,100));
      // Reviews tab
      const tabs=await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>t&&t.length<25));
      console.log('  tabs:',tabs.slice(0,15));
      await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reviews')?.click());
      await wait(1500);
      await ss(page,'U-org-reviews-tab');
      const revBody=await body(page);
      console.log('  reviews:',revBody.replace(/\n/g,' ').slice(0,200));
      // Back to event
      await goBack(page);
      await wait(1000);
      await ss(page,'U-back1-to-event');
      const b1=await body(page);
      console.log('  back1:',b1.replace(/\n/g,' ').slice(0,80));
      // Back to home
      await goBack(page);
      await wait(1000);
      await ss(page,'U-back2-to-home');
      const b2=await body(page);
      console.log('  back2:',b2.replace(/\n/g,' ').slice(0,80));
    }

    console.log('\n=== DONE ===');
  }catch(e){
    console.error('FATAL:',e.message,e.stack?.slice(0,200));
    try{await ss(page,'U-fatal');}catch{}
  }finally{
    await browser.close();
  }
})();
