const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=8000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(1000); await page.screenshot({ path: path.join(OUT, name+".png") }); console.log("V "+name); };

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    defaultViewport: {width:390,height:844},
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    userDataDir: "C:\\Temp\\pv-voice-"+Date.now()
  });
  const page = await browser.newPage();
  await page.setViewport({width:390,height:844});

  // Grant mic permission
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions("https://getvents.com", ["microphone"]);

  await page.goto("https://getvents.com", {waitUntil:"domcontentloaded",timeout:60000});
  await wait(4000);

  // Login as dero
  const isLoggedIn = await page.evaluate(() => [...document.querySelectorAll("button")].some(b => ["Home","Explore","Profile"].includes(b.textContent.trim())));
  if (!isLoggedIn) {
    await page.evaluate(() => { const el = [...document.querySelectorAll("*")].find(e => e.textContent.includes("Sign in") && !e.children.length); if (el) el.click(); });
    await wait(2000);
    await page.evaluate((em, pw) => {
      const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const fill = (el, v) => { if (!el) return; niv.call(el, v); el.dispatchEvent(new Event("input",{bubbles:true})); };
      const inputs = [...document.querySelectorAll("input")];
      fill(inputs.find(i => i.type==="email"||i.type==="text"), em);
      fill(inputs.find(i => i.type==="password"), pw);
    }, "djjackson361@gmail.com", "Dero2026$");
    await wait(500);
    await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.includes("Sign In"))?.click());
    await waitFor(page, "Home", 20000);
    await wait(1500);
    await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Home")?.click());
    await waitFor(page, "Featured", 8000);
  }

  // Go to Explore > Chats
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Explore")?.click());
  await wait(1500);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find(e => e.textContent.trim()==="Chats" && !e.children.length);
    if (!el) return;
    let cur = el;
    for (let i = 0; i < 8; i++) {
      const pk = Object.keys(cur||{}).find(k => k.startsWith("__reactProps$"));
      if (pk && cur[pk]?.onClick) { cur[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}}); return; }
      cur = cur?.parentElement;
    }
    el.click();
  });
  await wait(2000);

  // Open VENTS conversation
  await page.mouse.click(195, 142);
  await wait(3000);
  await ss(page, "VOICE-01-conversation-open");

  // Find mic button (MapPin is at ~27, Mic at ~57, Send at ~350 based on input row)
  // The mic button is the second button in the input row
  const micPos = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter(b => {
      const r = b.getBoundingClientRect();
      return r.y > 780 && r.y < 844 && r.width < 50;
    });
    console.log("bottom buttons:", btns.length, btns.map(b => JSON.stringify(b.getBoundingClientRect())).join(", "));
    const mic = btns.find(b => b.querySelector("svg") && !b.querySelector("svg path[d*='M']"));
    if (!mic) {
      // fallback: find by position - mic should be around x=55, y=820
      return btns.map(b => ({ x: Math.round(b.getBoundingClientRect().x + b.getBoundingClientRect().width/2), y: Math.round(b.getBoundingClientRect().y + b.getBoundingClientRect().height/2) }));
    }
    const r = mic.getBoundingClientRect();
    return [{ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }];
  });
  console.log("mic candidates:", JSON.stringify(micPos));
  // Mic button is typically the 2nd small button (after location pin)
  const micBtn = Array.isArray(micPos) ? micPos[1] || micPos[0] : micPos;
  console.log("using mic pos:", JSON.stringify(micBtn));
  if (!micBtn) { console.log("no mic btn found"); await browser.close(); return; }

  // Long-press the mic button to start recording (mousedown for 2s, then mouseup)
  await page.mouse.move(micBtn.x, micBtn.y);
  await page.mouse.down();
  await wait(2500); // record for ~2.5 seconds
  await ss(page, "VOICE-02-recording");
  await page.mouse.up();
  await wait(3000); // wait for upload

  // Check if voice note appears
  const bodyAfter = await page.evaluate(() => document.body.innerText);
  console.log("after recording:", bodyAfter.replace(/\n/g," ").slice(-300));
  await ss(page, "VOICE-03-sent");

  // Scroll to bottom to see the voice message
  await page.evaluate(() => {
    const divs = [...document.querySelectorAll("div")].filter(e => {
      const r = e.getBoundingClientRect(); const cs = window.getComputedStyle(e);
      return r.height > 200 && r.height < 700 && r.width > 300 && (cs.overflowY==="auto"||cs.overflowY==="scroll");
    }).sort((a,b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
    if (divs[0]) divs[0].scrollTop = divs[0].scrollHeight;
  });
  await wait(1000);

  // Click play on the latest voice message
  const playBtnPos = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter(b => {
      const r = b.getBoundingClientRect();
      return r.width > 25 && r.width < 45 && r.height > 25 && r.height < 45 && r.y > 200;
    });
    // Find the last one (most recent voice note)
    const last = btns[btns.length - 1];
    if (!last) return null;
    const r = last.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  });
  console.log("play btn pos:", JSON.stringify(playBtnPos));

  if (playBtnPos) {
    await page.mouse.click(playBtnPos.x, playBtnPos.y);
    await wait(1500);
    await ss(page, "VOICE-04-playing");
    const bodyPlaying = await page.evaluate(() => document.body.innerText);
    console.log("playing state:", bodyPlaying.replace(/\n/g," ").slice(-200));
  } else {
    console.log("no play button found, taking screenshot anyway");
    await ss(page, "VOICE-04-no-play-btn");
  }

  console.log("DONE");
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message, e.stack?.slice(0,200)); process.exit(1); });
