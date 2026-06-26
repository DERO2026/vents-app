const puppeteer = require('puppeteer');
const path = require('path');
const OUT = path.join(__dirname, 'screenshots');
const DERO_EMAIL = 'djjackson361@gmail.com';
const DERO_PASS  = 'Dero2026$';
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=10000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(1800); await page.screenshot({ path: path.join(OUT, name+'.png') }); console.log('V '+name); };
const body = page => page.evaluate(() => document.body.innerText);
const rc = (page, txt) => page.evaluate(t => {
  const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()===t&&!e.children.length);
  if(!el)return'nf:'+t;
  let cur=el;
  for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps\$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return'ok';}cur=cur?.parentElement;}
  el.click();return'nat';
}, txt);
const goBack = async (page) => {
  await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(btn=>{const r=btn.getBoundingClientRect();return r.x<80&&r.y<120&&r.y>=0&&btn.querySelector('svg');});if(b){const pk=Object.keys(b).find(k=>k.startsWith('__reactProps\$'));if(pk&&b[pk]?.onClick)b[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else b.click();}});
  await wait(1500);
};
const login = async (page, email, pass) => {
  await page.goto('https://getvents.com',{waitUntil:'domcontentloaded',timeout:60000});
  await wait(4000);
  await page.evaluate(()=>[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()==='Sign in'||e.textContent.trim()==='Sign In')?.click());
  await wait(1500);
  await page.evaluate((e,p)=>{
    const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    const inputs=[...document.querySelectorAll('input')];
    const em=inputs.find(i=>i.type==='email'||i.type==='text');
    const pw=inputs.find(i=>i.type==='password');
    const fill=(el,v)=>{if(!el)return;niv.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    fill(em,e);fill(pw,p);
  },email,pass);
  await wait(400);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign In')?.click());
  await waitFor(page,'Home',15000); await wait(2000);
};
(async()=>{
  const browser=await puppeteer.launch({
    headless:false, executablePath:'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
    defaultViewport:{width:390,height:844}, args:['--window-size=430,900','--no-sandbox'],
    userDataDir:'C:\\\\Temp\\\\pv-fresh-'+Date.now(),
  });
  const page=await browser.newPage(); await page.setViewport({width:390,height:844});
  try {
    await login(page,DERO_EMAIL,DERO_PASS);
    await ss(page,'X-01-home');
    const bt=await body(page); console.log('home:',bt.replace(/\n/g,' ').slice(0,100));
    // find event card
    const card=await page.evaluate(()=>{
      const imgs=[...document.querySelectorAll('img')].map(i=>{const r=i.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),h:Math.round(r.height),top:Math.round(r.top)};}).filter(i=>i.h>60&&i.top>0&&i.top<800);
      return imgs[0]||null;
    });
    console.log('card:',JSON.stringify(card));
    if(!card){const bt2=await body(page);console.log('full:',bt2.replace(/\n/g,' ').slice(0,500));await browser.close();return;}
    await page.mouse.click(card.x,card.y);
    const gotEvent=await waitFor(page,'Book',8000)||await waitFor(page,'organizer',6000)||await wait(4000);
    await wait(1500); await ss(page,'X-02-depth1-event');
    const d1=await body(page); console.log('d1:',d1.replace(/\n/g,' ').slice(0,80));
    // scroll to organizer
    for(let i=0;i<40;i++){
      const f=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
      if(f){console.log('found org at scroll',i);break;}
      await page.evaluate(()=>{const els=[...document.querySelectorAll('div')].filter(e=>{const r=e.getBoundingClientRect();const cs=window.getComputedStyle(e);return e instanceof Element&&r.width>300&&r.height>200&&r.height<window.innerHeight&&(cs.overflowY==='auto'||cs.overflowY==='scroll');}).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);if(els[0])els[0].scrollBy(0,300);else window.scrollBy(0,300);});
      await wait(120);
    }
    await ss(page,'X-03-event-scrolled');
    const hasOrg=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
    console.log('hasOrg:',hasOrg);
    if(!hasOrg){console.log('no org btn');await browser.close();return;}
    await rc(page,'See organizer reviews'); await wait(3500);
    await ss(page,'X-04-depth2-org-profile');
    const d2=await body(page); console.log('d2:',d2.replace(/\n/g,' ').slice(0,100));
    const tabs=await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>t.length>0&&t.length<25));
    console.log('tabs:',tabs.slice(0,12));
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reviews')?.click());
    await wait(2000); await ss(page,'X-05-reviews-tab');
    const rv=await body(page); console.log('reviews:',rv.replace(/\n/g,' ').slice(0,200));
    // back to event
    await goBack(page); await wait(500); await ss(page,'X-06-back1-event');
    const b1=await body(page); console.log('back1:',b1.replace(/\n/g,' ').slice(0,60));
    // back to home
    await goBack(page); await wait(500); await ss(page,'X-07-back2-home');
    const b2=await body(page); console.log('back2:',b2.replace(/\n/g,' ').slice(0,60));
    console.log('DONE');
  } catch(e){console.error('FATAL:',e.message,e.stack?.slice(0,200));try{await ss(page,'X-fatal');}catch{}}
  finally{await browser.close();}
})();
