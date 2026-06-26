const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=10000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(1500); await page.screenshot({ path: path.join(OUT, name+".png") }); process.stdout.write("V "+name+"\n"); };
const body = page => page.evaluate(() => document.body.innerText);
const rcFull = (page, txt) => page.evaluate(t => {
  const el=[...document.querySelectorAll("*")].find(e=>e.textContent.trim()===t&&!e.children.length);
  if(!el)return"nf:"+t; let cur=el;
  for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith("__reactProps$"));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}});return"ok";}cur=cur?.parentElement;}
  el.click();return"nat";
}, txt);
(async()=>{
  process.stdout.write("START\n");
  const browser=await puppeteer.launch({headless:false,executablePath:"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",defaultViewport:{width:390,height:844},args:["--no-sandbox"],userDataDir:"C:\\Temp\\pv-loc4"});
  process.stdout.write("browser open\n");
  const page=await browser.newPage();await page.setViewport({width:390,height:844});
  const context=browser.defaultBrowserContext();
  await context.overridePermissions("https://getvents.com",["geolocation"]);
  await page.setGeolocation({latitude:6.5244,longitude:3.3792,accuracy:100});
  await page.goto("https://getvents.com",{waitUntil:"domcontentloaded",timeout:60000});await wait(3000);
  process.stdout.write("loaded\n");
  await page.evaluate(()=>[...document.querySelectorAll("button,a")].find(e=>e.textContent.includes("Sign in"))?.click());
  await wait(1500);
  await page.evaluate((e,p)=>{const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;const inputs=[...document.querySelectorAll("input")];const em=inputs.find(i=>i.type==="email"||i.type==="text");const pw=inputs.find(i=>i.type==="password");const fill=(el,v)=>{if(!el)return;niv.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));};fill(em,e);fill(pw,p);},"djjackson361@gmail.com","Dero2026$");
  await wait(400);
  await page.evaluate(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Sign In")?.click());
  const ok=await waitFor(page,"Home",15000); process.stdout.write("login:"+ok+"\n"); if(!ok){await browser.close();return;}
  await wait(2000);
  await page.evaluate(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Explore")?.click());
  await wait(1500); await rcFull(page,"Chats"); await wait(2000);
  await ss(page,"LOC-01-chats");
  const bt=await body(page); process.stdout.write("chats:"+bt.replace(/\n/g," ").slice(0,200)+"\n");
  await page.mouse.click(195,200);
  await waitFor(page,"Hello",5000)||await wait(2000); await wait(500);
  await ss(page,"LOC-02-conv");
  const d=await body(page); process.stdout.write("conv:"+d.replace(/\n/g," ").slice(0,150)+"\n");
  await page.evaluate(()=>{const divs=[...document.querySelectorAll("div")].filter(e=>{const r=e.getBoundingClientRect();const cs=window.getComputedStyle(e);return e instanceof Element&&r.height>200&&r.height<700&&r.width>300&&(cs.overflowY==="auto"||cs.overflowY==="scroll");}).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);if(divs[0])divs[0].scrollTop=divs[0].scrollHeight;});
  await wait(500);
  const inputBtns=await page.evaluate(()=>[...document.querySelectorAll("button")].filter(b=>{const r=b.getBoundingClientRect();return r.top>750&&r.top<860;}).map(b=>{const r=b.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),title:b.title.slice(0,30)};}).slice(0,8));
  process.stdout.write("inputBtns:"+JSON.stringify(inputBtns)+"\n");
  // Send location via 2nd button
  await page.evaluate(()=>{
    const btns=[...document.querySelectorAll("button")].filter(b=>{const r=b.getBoundingClientRect();return r.top>750&&r.top<860&&!b.textContent.trim();});
    const b=btns[1]||btns[0];
    if(b){const pk=Object.keys(b).find(k=>k.startsWith("__reactProps$"));if(pk&&b[pk]?.onClick)b[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}});else b.click();}
  });
  process.stdout.write("clicked loc btn\n");
  await wait(5000);
  await page.evaluate(()=>{const divs=[...document.querySelectorAll("div")].filter(e=>{const r=e.getBoundingClientRect();const cs=window.getComputedStyle(e);return e instanceof Element&&r.height>200&&r.height<700&&r.width>300&&(cs.overflowY==="auto"||cs.overflowY==="scroll");}).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);if(divs[0])divs[0].scrollTop=divs[0].scrollHeight;});
  await wait(1000); await ss(page,"LOC-03-loc-msg");
  const d3=await body(page); process.stdout.write("after:"+d3.replace(/\n/g," ").slice(-400)+"\n");
  process.stdout.write("DONE\n");
  await browser.close();
})().catch(e=>{process.stdout.write("FATAL:"+e.message+"\n");process.exit(1);});
