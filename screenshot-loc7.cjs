const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=10000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(1500); await page.screenshot({ path: path.join(OUT, name+".png") }); process.stdout.write("V "+name+"\n"); };

(async()=>{
  const browser=await puppeteer.launch({headless:false,executablePath:"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",defaultViewport:{width:390,height:844},args:["--no-sandbox"],userDataDir:"C:\\Temp\\pv-loc-fresh-"+Date.now()});
  const page=await browser.newPage();await page.setViewport({width:390,height:844});
  await page.goto("https://getvents.com",{waitUntil:"domcontentloaded",timeout:60000});await wait(4000);
  
  const isLoggedIn=await page.evaluate(()=>[...document.querySelectorAll("button")].some(b=>["Home","Explore","Profile"].includes(b.textContent.trim())));
  process.stdout.write("loggedIn:"+isLoggedIn+"\n");
  if(!isLoggedIn){
    await page.evaluate(()=>{const el=[...document.querySelectorAll("*")].find(e=>e.textContent.includes("Sign in")&&!e.children.length);if(el)el.click();});
    await wait(2000);
    await page.evaluate((em,pw)=>{
      const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
      const fill=(el,v)=>{if(!el)return;niv.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}));};
      const inputs=[...document.querySelectorAll("input")];
      fill(inputs.find(i=>i.type==="email"||i.type==="text"),em);
      fill(inputs.find(i=>i.type==="password"),pw);
    },"djjackson361@gmail.com","Dero2026$");
    await wait(500);
    await page.evaluate(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Sign In"))?.click());
    await waitFor(page,"Home",20000);await wait(2000);
    await page.evaluate(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Home")?.click());
    await waitFor(page,"Featured",8000);await wait(1500);
    process.stdout.write("logged in OK\n");
  }
  
  // Explore -> Chats
  await page.evaluate(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Explore")?.click());
  await wait(1500);
  await page.evaluate(()=>{const el=[...document.querySelectorAll("*")].find(e=>e.textContent.trim()==="Chats"&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith("__reactProps$"));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
  await wait(2000);
  await ss(page,"LOC-00-chats-list");
  
  // Click conversation
  await page.mouse.click(195, 142);
  await wait(3000);
  await ss(page,"LOC-01-convo-open");
  const d1=await page.evaluate(()=>document.body.innerText);
  process.stdout.write("conv:"+d1.replace(/\n/g," ").slice(-400)+"\n");
  
  // Scroll to bottom
  await page.evaluate(()=>{
    const divs=[...document.querySelectorAll("div")].filter(e=>{
      const r=e.getBoundingClientRect();const cs=window.getComputedStyle(e);
      return r.height>200&&r.height<700&&r.width>300&&(cs.overflowY==="auto"||cs.overflowY==="scroll");
    }).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);
    if(divs[0])divs[0].scrollTop=divs[0].scrollHeight;
  });
  await wait(2500);
  await ss(page,"LOC-02-location-card");
  const d2=await page.evaluate(()=>document.body.innerText);
  process.stdout.write("bottom:"+d2.replace(/\n/g," ").slice(-600)+"\n");
  
  process.stdout.write("DONE\n");
  await browser.close();
})().catch(e=>{process.stdout.write("FATAL:"+e.message+"\n");process.exit(1);});
