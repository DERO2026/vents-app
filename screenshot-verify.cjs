const puppeteer = require('puppeteer');
const path = require('path');
const OUT = path.join(__dirname, 'screenshots');
const DERO_EMAIL = 'djjackson361@gmail.com';
const DERO_PASS  = 'Dero2026$';
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=8000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(2200); await page.screenshot({ path: path.join(OUT, name+'.png') }); console.log('  V '+name); };
const body = page => page.evaluate(() => document.body.innerText);
const rc = (page, txt) => page.evaluate(t => {
  const el=[...document.querySelectorAll('*')].find(e=>e.textContent.trim()===t&&!e.children.length);
  if(!el)return'nf:'+t;
  let cur=el;
  for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith('__reactProps$'));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});return'ok';}cur=cur?.parentElement;}
  el.click();return'nat';
}, txt);
const goBack = async (page) => { await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(btn=>{const r=btn.getBoundingClientRect();return r.x<80&&r.y<120&&r.y>=0&&btn.querySelector('svg');});if(b){const pk=Object.keys(b).find(k=>k.startsWith('__reactProps$'));if(pk&&b[pk]?.onClick)b[pk].onClick({type:'click',preventDefault:()=>{},stopPropagation:()=>{}});else b.click();}});await wait(1200);};
(async()=>{
  const browser=await puppeteer.launch({
    headless:false, executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport:{width:390,height:844}, args:['--window-size=430,900','--no-sandbox'],
    userDataDir:'C:\\Temp\\puppeteer-vents-verify',
  });
  const page=await browser.newPage(); await page.setViewport({width:390,height:844});
  try {
    await page.goto('https://getvents.com',{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>document.querySelectorAll('button').length>0,{timeout:30000});
    await wait(5000);
    const bl=(await body(page)).toLowerCase();
    if(bl.includes('get started')||bl.includes('discover')){await page.evaluate(()=>[...document.querySelectorAll('*')].find(e=>e.textContent.trim()==='Sign in'&&!e.children.length)?.click());await wait(2000);}
    await page.evaluate((e,p)=>{const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;const fill=(el,v)=>{if(!el)return;niv.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};fill(document.querySelector('input[type="text"]'),e);fill(document.querySelector('input[type="password"]'),p);},DERO_EMAIL,DERO_PASS);
    await wait(400);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign In')?.click());
    await waitFor(page,'Home',15000); await wait(2500);
    await ss(page,'V-home');
    // Profile > Settings > Profile Details > set username xy > save
    await rc(page,'Profile'); await wait(1500);
    await rc(page,'Settings'); await waitFor(page,'Profile Details',5000); await wait(600);
    await rc(page,'Profile Details'); await waitFor(page,'Full Name',5000); await wait(1200);
    await page.evaluate(()=>{const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='file'&&i.type!=='checkbox'&&i.type!=='radio'&&i.type!=='hidden');const u=inputs[1];if(!u)return;niv.call(u,'xy');u.dispatchEvent(new Event('input',{bubbles:true}));u.dispatchEvent(new Event('change',{bubbles:true}));u.dispatchEvent(new Event('blur',{bubbles:true}));});
    await wait(500);
    await rc(page,'Save Changes'); await wait(3000);
    await ss(page,'V-username-error');
    const errBody=await body(page);
    console.log('error body:',errBody.replace(/\n/g,' ').slice(0,300));
    // Restore dero
    await page.evaluate(()=>{const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='file'&&i.type!=='checkbox'&&i.type!=='radio'&&i.type!=='hidden');const u=inputs[1];if(!u)return;niv.call(u,'dero');u.dispatchEvent(new Event('input',{bubbles:true}));u.dispatchEvent(new Event('change',{bubbles:true}));});
    await wait(400); await rc(page,'Save Changes'); await wait(2500);
    console.log('restored dero');
    // Back to home
    await goBack(page); await goBack(page); await goBack(page);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Home')?.click());
    await waitFor(page,'Featured',5000)||await wait(2500); await wait(1500);
    const homeNow=await body(page);
    console.log('home:',homeNow.replace(/\n/g,' ').slice(0,60));
    // Click event card
    const card=await page.evaluate(()=>{const imgs=[...document.querySelectorAll('img')].filter(i=>{const r=i.getBoundingClientRect();return r.height>100&&r.width>200&&r.top>50&&r.top<700;});if(!imgs[0])return null;const r=imgs[0].getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};});
    console.log('card:',JSON.stringify(card));
    if(card){
      await page.mouse.click(card.x,card.y);
      await waitFor(page,'Book',8000)||await waitFor(page,'Date',6000)||await wait(4000);
      await wait(2000); await ss(page,'V-depth1');
      const d1=await body(page);
      console.log('depth1:',d1.replace(/\n/g,' ').slice(0,80));
      if(d1.includes('Book')||d1.includes('Date')||d1.includes('attending')){
        for(let i=0;i<30;i++){
          const f=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
          if(f){console.log('org@scroll',i);break;}
          await page.evaluate(()=>{const divs=[...document.querySelectorAll('div')].filter(e=>{const r=e.getBoundingClientRect();const cs=window.getComputedStyle(e);return r.width>300&&r.height>400&&r.height<900&&(cs.overflowY==='auto'||cs.overflowY==='scroll');}).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);if(divs[0])divs[0].scrollBy(0,200);else window.scrollBy(0,200);});
          await wait(150);
        }
        const hasOrg=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
        console.log('hasOrg:',hasOrg); await ss(page,'V-event-org');
        if(hasOrg){
          await rc(page,'See organizer reviews'); await wait(3000);
          await ss(page,'V-depth2-org');
          const d2=await body(page);
          console.log('depth2:',d2.replace(/\n/g,' ').slice(0,80));
          await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reviews')?.click());
          await wait(1500); await ss(page,'V-reviews-tab');
          const rev=await body(page); console.log('reviews:',rev.replace(/\n/g,' ').slice(0,150));
          await goBack(page); await wait(1000); await ss(page,'V-back1');
          const b1=await body(page); console.log('back1:',b1.replace(/\n/g,' ').slice(0,60));
          await goBack(page); await wait(1000); await ss(page,'V-back2');
          const b2=await body(page); console.log('back2:',b2.replace(/\n/g,' ').slice(0,60));
        }
      }
    }
    console.log('DONE');
  } catch(e){ console.error('FATAL:',e.message); try{await ss(page,'V-fatal');}catch{} }
  finally { await browser.close(); }
})();
