const puppeteer = require('puppeteer');
const path = require('path');
const OUT = path.join(__dirname, 'screenshots');
const DERO_EMAIL = 'djjackson361@gmail.com';
const DERO_PASS  = 'Dero2026$';
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=8000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(2000); await page.screenshot({ path: path.join(OUT, name+'.png') }); console.log('  V '+name); };
const body = page => page.evaluate(() => document.body.innerText);
const rc = (page, txt) => page.evaluate(t => {
  const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()===t&&!e.children.length);
  if(!el)return'nf:'+t;
  let cur=el;
  for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return'ok';}cur=cur?.parentElement;}
  el.click();return'nat';
}, txt);
const goBack = async (page) => {
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(btn=>{const r=btn.getBoundingClientRect();return r.x<80&&r.y<120&&r.y>=0&&btn.querySelector('svg');});if(b){const pk=Object.keys(b).find(k=>k.startsWith('__reactProps$'));if(pk&&b[pk]?.onClick)b[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else b.click();}});
  await wait(1200);
};
(async()=>{
  const browser=await puppeteer.launch({
    headless:false, executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport:{width:390,height:844}, args:['--window-size=430,900','--no-sandbox'],
    userDataDir:'C:\\Temp\\puppeteer-nav-test',
  });
  const page=await browser.newPage(); await page.setViewport({width:390,height:844});
  try {
    await page.goto('https://getvents.com',{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>document.querySelectorAll('button').length>0,{timeout:30000});
    await wait(5000);
    const bl=(await body(page)).toLowerCase();
    if(bl.includes('get started')||bl.includes('discover')||bl.includes('sign in')){
      const si=[...await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()))].find(t=>t==='Sign in'||t==='Sign In');
      await page.evaluate(t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t)?.click(), si||'Sign in');
      await wait(1500);
      await page.evaluate((e,p)=>{const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;const fill=(el,v)=>{if(!el)return;niv.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};fill(document.querySelector('input[type="text"]')||document.querySelectorAll('input')[0],e);fill(document.querySelector('input[type="password"]'),p);},DERO_EMAIL,DERO_PASS);
      await wait(400);
      await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign In')?.click());
      await waitFor(page,'Home',15000);
    }
    await wait(2500); await ss(page,'W-home');
    // Click event card
    const card=await page.evaluate(()=>{const imgs=[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.height>80&&r.width>150&&r.top>50&&r.top<700;});if(!imgs[0])return null;const r=imgs[0].getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};});
    console.log('card:',JSON.stringify(card));
    if(!card){await ss(page,'W-no-card');await browser.close();return;}
    await page.mouse.click(card.x,card.y);
    await waitFor(page,'Book',8000)||await waitFor(page,'Date',6000)||await wait(4000);
    await wait(1500); await ss(page,'W-depth1-event');
    const d1=await body(page);
    console.log('depth1:',d1.replace(/\n/g,' ').slice(0,80));
    // Scroll to See organizer reviews
    for(let i=0;i<30;i++){
      const f=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
      if(f){console.log('org@',i);break;}
      await page.evaluate(()=>{const els=[...document.querySelectorAll('div')].filter(e=>{const r=e.getBoundingClientRect();const cs=window.getComputedStyle(e);return e instanceof Element&&r.width>300&&r.height>300&&r.height<window.innerHeight&&(cs.overflowY==='auto'||cs.overflowY==='scroll');}).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);if(els[0])els[0].scrollBy(0,250);else window.scrollBy(0,250);});
      await wait(150);
    }
    await ss(page,'W-event-scroll');
    const hasOrg=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
    console.log('hasOrg:',hasOrg);
    if(hasOrg){
      // depth 2
      await rc(page,'See organizer reviews'); await wait(3000);
      await ss(page,'W-depth2-org-profile');
      const d2=await body(page);
      console.log('depth2:',d2.replace(/\n/g,' ').slice(0,100));
      // Reviews tab
      const tabs=await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()));
      console.log('tabs:',tabs.filter(t=>t&&t.length<30).slice(0,15));
      await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reviews')?.click());
      await wait(2000); await ss(page,'W-depth2-reviews-tab');
      // back to event
      await goBack(page); await wait(800); await ss(page,'W-back1-event');
      const b1=await body(page); console.log('back1:',b1.replace(/\n/g,' ').slice(0,60));
      // back to home
      await goBack(page); await wait(800); await ss(page,'W-back2-home');
      const b2=await body(page); console.log('back2:',b2.replace(/\n/g,' ').slice(0,60));
    }
    console.log('DONE');
  } catch(e){ console.error('FATAL:',e.message); try{await ss(page,'W-fatal');}catch{} }
  finally { await browser.close(); }
})();
