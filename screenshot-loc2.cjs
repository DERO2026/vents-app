const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=10000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(1500); await page.screenshot({ path: path.join(OUT, name+".png") }); process.stdout.write("V "+name+"\n"); };
const body = page => page.evaluate(() => document.body.innerText);
(async()=>{
  process.stdout.write("START\n");
  const browser=await puppeteer.launch({headless:false,executablePath:"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",defaultViewport:{width:390,height:844},args:["--no-sandbox"],userDataDir:"C:\\Temp\\pv-loc5"});
  const page=await browser.newPage();await page.setViewport({width:390,height:844});
  const context=browser.defaultBrowserContext();
  await context.overridePermissions("https://getvents.com",["geolocation"]);
  await page.setGeolocation({latitude:6.5244,longitude:3.3792,accuracy:100});
  await page.goto("https://getvents.com",{waitUntil:"domcontentloaded",timeout:60000});await wait(3000);
  await page.evaluate(()=>[...document.querySelectorAll("button,a")].find(e=>e.textContent.includes("Sign in"))?.click());
  await wait(1500);
  await page.evaluate((e,p)=>{const niv=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;const inputs=[...document.querySelectorAll("input")];const em=inputs.find(i=>i.type==="email"||i.type==="text");const pw=inputs.find(i=>i.type==="password");const fill=(el,v)=>{if(!el)return;niv.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));};fill(em,e);fill(pw,p);},"djjackson361@gmail.com","Dero2026$");
  await wait(400);
  await page.evaluate(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Sign In")?.click());
  const ok=await waitFor(page,"Home",15000); if(!ok){await browser.close();return;}
  await wait(2000);
  // Go to Explore > Chats  
  await page.evaluate(()=>[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Explore")?.click());
  await wait(1500);
  // Click Chats tab
  await page.evaluate(()=>{const el=[...document.querySelectorAll("*")].find(e=>e.textContent.trim()==="Chats"&&!e.children.length);if(!el)return;let cur=el;for(let i=0;i<8;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith("__reactProps$"));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}});return;}cur=cur?.parentElement;}el.click();});
  await wait(2000);
  const bt=await body(page); process.stdout.write("chats:"+bt.replace(/\n/g," ").slice(0,200)+"\n");
  await ss(page,"LOC-01-chats");
  // Click VENTS chat item
  const convR=await page.evaluate(()=>{
    const el=[...document.querySelectorAll("*")].find(e=>e.textContent.includes("VENTS")&&e.getBoundingClientRect().height>40&&e.getBoundingClientRect().height<200&&e.getBoundingClientRect().width>300);
    if(!el)return"nf";
    let cur=el;
    for(let i=0;i<10;i++){const pk=Object.keys(cur||{}).find(k=>k.startsWith("__reactProps$"));if(pk&&cur[pk]?.onClick){cur[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}});return"ok";}cur=cur?.parentElement;}
    el.click();return"nat";
  });
  process.stdout.write("convClick:"+convR+"\n");
  await wait(3000);
  const d=await body(page); process.stdout.write("in conv:"+d.replace(/\n/g," ").slice(0,200)+"\n");
  await ss(page,"LOC-02-in-conv");
  // Check if we're in a conversation (should have msg history)
  const inConv=d.includes("Hello")||d.includes("am")||d.includes("pm");
  if(!inConv){process.stdout.write("NOT IN CONV - trying coordinate click\n");
    // Find VENTS item position
    const pos=await page.evaluate(()=>{const el=[...document.querySelectorAll("div")].filter(e=>{const r=e.getBoundingClientRect();return r.height>50&&r.height<150&&r.width>300&&r.top>80&&r.top<500;}).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);if(!el[0])return null;const r=el[0].getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};});
    process.stdout.write("pos:"+JSON.stringify(pos)+"\n");
    if(pos){await page.mouse.click(pos.x,pos.y);await wait(3000);await ss(page,"LOC-02b-conv-click");}}
  // Find chat input area buttons (small buttons, bottom area)
  const allBtns=await page.evaluate(()=>[...document.querySelectorAll("button")].map(b=>{const r=b.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height),title:b.title,text:b.textContent.trim().slice(0,20)};}).filter(b=>b.y>700&&b.w<100));
  process.stdout.write("allBtns:"+JSON.stringify(allBtns.slice(0,10))+"\n");
  // Click location pin button (should be a small icon button below the message input, not the nav)
  // Look specifically for button with MapPin SVG
  const locClick=await page.evaluate(()=>{
    const btns=[...document.querySelectorAll("button")].filter(b=>{const r=b.getBoundingClientRect();return r.top>700&&r.top<870&&r.width>20&&r.width<60;});
    for(const b of btns){
      const html=b.innerHTML;
      if(html.includes("d=\"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z\"")||html.includes("M12 2")||html.includes("map-pin")||html.includes("MapPin")){
        process.stdout.write("Found MapPin button!\n");
        const pk=Object.keys(b).find(k=>k.startsWith("__reactProps$"));
        if(pk&&b[pk]?.onClick){b[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}});return"ok-react";}
        b.click();return"ok-native";
      }
    }
    return"nf-no-mappin";
  });
  process.stdout.write("locClick:"+locClick+"\n");
  await wait(6000);
  await page.evaluate(()=>{const divs=[...document.querySelectorAll("div")].filter(e=>{const r=e.getBoundingClientRect();const cs=window.getComputedStyle(e);return e instanceof Element&&r.height>200&&r.height<700&&r.width>300&&(cs.overflowY==="auto"||cs.overflowY==="scroll");}).sort((a,b)=>b.getBoundingClientRect().height-a.getBoundingClientRect().height);if(divs[0])divs[0].scrollTop=divs[0].scrollHeight;});
  await wait(1000); await ss(page,"LOC-03-result");
  const d3=await body(page); process.stdout.write("result:"+d3.replace(/\n/g," ").slice(-500)+"\n");
  process.stdout.write("DONE\n");
  await browser.close();
})().catch(e=>{process.stdout.write("FATAL:"+e.message+"\n");process.exit(1);});
