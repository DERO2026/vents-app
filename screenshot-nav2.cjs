const puppeteer = require('puppeteer');
const path = require('path');
const OUT = path.join(__dirname, 'screenshots');
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
  await wait(1500);
};
(async()=>{
  const browser=await puppeteer.launch({
    headless:false, executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport:{width:390,height:844}, args:['--window-size=430,900','--no-sandbox'],
    userDataDir:'C:\\Temp\\puppeteer-vents-verify',
  });
  const page=await browser.newPage(); await page.setViewport({width:390,height:844});
  // Reload fresh to reset React state
  await page.goto('https://getvents.com',{waitUntil:'domcontentloaded',timeout:60000});
  await wait(5000);
  const bl=(await body(page)).toLowerCase();
  console.log('page:',bl.slice(0,100));
  // Should be logged in - check
  const onApp=bl.includes('home')||bl.includes('featured')||bl.includes('explore');
  console.log('onApp:',onApp);
  if(!onApp){console.log('not logged in - exiting');await browser.close();return;}
  await wait(1000); await ss(page,'X-home');
  // Check home content and images
  const imgs=await page.evaluate(()=>[...document.querySelectorAll('img')].map(i=>{const r=i.getBoundingClientRect();return{w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top)};}));
  console.log('imgs:',JSON.stringify(imgs.slice(0,8)));
  // Find clickable event cards - look for images or divs with background
  const cards=await page.evaluate(()=>{
    const allImgs=[...document.querySelectorAll('img')].map(i=>{const r=i.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),h:r.height,w:r.width,top:r.top};}).filter(i=>i.h>60&&i.w>100&&i.top>0&&i.top<700);
    return allImgs;
  });
  console.log('cards found:',JSON.stringify(cards.slice(0,5)));
  if(cards.length===0){
    // try clicking an event title text
    const eventTitles=await page.evaluate(()=>{
      const texts=[...document.querySelectorAll('h2,h3,h4,p')].map(e=>{const r=e.getBoundingClientRect();return{text:e.textContent.trim().slice(0,40),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),top:r.top};}).filter(e=>e.top>50&&e.top<700&&e.text.length>3);
      return eventTitles.slice(0,5);
    });
    console.log('event titles:',JSON.stringify(eventTitles));
    // body text
    const bt=await body(page);
    console.log('body slice:',bt.replace(/\n/g,' ').slice(0,400));
  } else {
    await page.mouse.click(cards[0].x,cards[0].y);
    await waitFor(page,'Book',8000)||await waitFor(page,'organizer',6000)||await wait(4000);
    await wait(1500); await ss(page,'X-depth1');
    const d1=await body(page);
    console.log('depth1:',d1.replace(/\n/g,' ').slice(0,100));
    // scroll to See organizer reviews
    for(let i=0;i<30;i++){
      const f=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
      if(f){console.log('org@',i);break;}
      await page.evaluate(()=>{const els=[...document.querySelectorAll('div')].filter(e=>{const r=e.getBoundingClientRect();const cs=window.getComputedStyle(e);return e instanceof Element&&r.width>300&&r.height>200&&r.height<window.innerHeight&&(cs.overflowY==='auto'||cs.overflowY==='scroll');}).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);if(els[0])els[0].scrollBy(0,250);else window.scrollBy(0,250);});
      await wait(150);
    }
    await ss(page,'X-event-scrolled');
    const hasOrg=await page.evaluate(()=>document.body.innerText.includes('See organizer reviews'));
    console.log('hasOrg:',hasOrg);
    if(hasOrg){
      await rc(page,'See organizer reviews'); await wait(3000);
      await ss(page,'X-depth2-org');
      const d2=await body(page); console.log('depth2:',d2.replace(/\n/g,' ').slice(0,100));
      await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Reviews')?.click());
      await wait(2000); await ss(page,'X-reviews-tab');
      const rv=await body(page); console.log('reviews:',rv.replace(/\n/g,' ').slice(0,200));
      await goBack(page); await ss(page,'X-back1'); const b1=await body(page); console.log('back1:',b1.replace(/\n/g,' ').slice(0,60));
      await goBack(page); await ss(page,'X-back2'); const b2=await body(page); console.log('back2:',b2.replace(/\n/g,' ').slice(0,60));
    }
  }
  await browser.close();
  console.log('DONE');
})().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
