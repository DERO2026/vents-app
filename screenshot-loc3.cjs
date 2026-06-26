const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=10000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(1500); await page.screenshot({ path: path.join(OUT, name+".png") }); process.stdout.write("V "+name+"\n"); };
const body = page => page.evaluate(() => document.body.innerText);
(async()=>{
  const browser=await puppeteer.launch({headless:false,executablePath:"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",defaultViewport:{width:390,height:844},args:["--no-sandbox"],userDataDir:"C:\\Temp\\pv-loc5"});
  const page=await browser.newPage();await page.setViewport({width:390,height:844});
  const context=browser.defaultBrowserContext();
  await context.overridePermissions("https://getvents.com",["geolocation"]);
  await page.setGeolocation({latitude:6.5244,longitude:3.3792,accuracy:100});
  await page.goto("https://getvents.com",{waitUntil:"domcontentloaded",timeout:60000});await wait(4000);
  const onApp=await page.evaluate(()=>[...document.querySelectorAll("button")].some(b=>["Home","Explore","Profile"].includes(b.textContent.trim())));
  process.stdout.write("onApp:"+onApp+"\n");
  if(!onApp){await browser.close();return;}
  await page.evaluate(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Explore")?.click());
  await wait(1500);
  await page.evaluate(()=>{const el=[...document.querySelectorAll("*")].find(e=>e.textContent.trim()==="Chats"&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith("__reactProps$"));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
  await wait(2000);
  // Click VENTS chat
  await page.mouse.click(195, 142);
  await waitFor(page,"Hello",5000)||await wait(3000); await wait(1000);
  const d=await body(page); process.stdout.write("in conv:"+d.replace(/\n/g," ").slice(0,150)+"\n");
  await ss(page,"LOC-A-in-conv");
  // Click location button via reactProps - it is the 2nd small button (Image is 1st, MapPin is 2nd, Mic is 3rd)
  // All 3 are in the bottom input area; MapPin button is the 2nd non-text button
  const r=await page.evaluate(()=>{
    const btns=[...document.querySelectorAll("button")].filter(b=>{const r=b.getBoundingClientRect();return r.top>750&&r.top<870&&r.width<60&&!b.textContent.trim();});
    process.stdout.write("small btns: "+btns.length+"\n");
    if(btns.length<2)return"nf-not-enough-btns";
    const mapPinBtn=btns[1]; // 2nd button should be MapPin/location
    const pk=Object.keys(mapPinBtn).find(k=>k.startsWith("__reactProps$"));
    if(pk&&mapPinBtn[pk]?.onClick){mapPinBtn[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}});return"ok";}
    mapPinBtn.click();return"nat";
  });
  process.stdout.write("locClick:"+r+"\n");
  await wait(6000);
  // Scroll to see the location message
  await page.evaluate(()=>{const divs=[...document.querySelectorAll("div")].filter(e=>{const r=e.getBoundingClientRect();const cs=window.getComputedStyle(e);return e instanceof Element&&r.height>200&&r.height<700&&r.width>300&&(cs.overflowY==="auto"||cs.overflowY==="scroll");}).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);if(divs[0])divs[0].scrollTop=divs[0].scrollHeight;});
  await wait(1500); await ss(page,"LOC-B-sent");
  const d2=await body(page); process.stdout.write("result:"+d2.replace(/\n/g," ").slice(-500)+"\n");
  process.stdout.write("DONE\n");
  await browser.close();
})().catch(e=>{process.stdout.write("FATAL:"+e.message+"\n");process.exit(1);});
