const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=8000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(1200); await page.screenshot({ path: path.join(OUT, name+".png") }); console.log("V "+name); };
const rc = async (page, label) => {
  await page.evaluate(l => {
    const el = [...document.querySelectorAll("*")].find(e => e.textContent.trim() === l && !e.children.length);
    if (!el) return;
    let cur = el;
    for (let i = 0; i < 8; i++) {
      const pk = Object.keys(cur||{}).find(k => k.startsWith("__reactProps$"));
      if (pk && cur[pk]?.onClick) { cur[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}}); return; }
      cur = cur?.parentElement;
    }
    el.click();
  }, label);
};

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    defaultViewport: {width:390,height:844},
    args: ["--no-sandbox"],
    userDataDir: "C:\\Temp\\pv-settings-"+Date.now()
  });
  const page = await browser.newPage();
  await page.setViewport({width:390,height:844});
  await page.goto("https://getvents.com", {waitUntil:"domcontentloaded",timeout:60000});
  await wait(4000);

  // Login
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
  await wait(1000);

  // Navigate to Profile > Settings
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Profile")?.click());
  await wait(1500);
  await rc(page, "Settings");
  await waitFor(page, "Help Center", 5000);
  await wait(800);
  await ss(page, "SET-01-settings-screen");

  // 1. Help Center
  const pages1 = [];
  browser.on("targetcreated", t => pages1.push(t));
  await rc(page, "Help Center");
  await wait(2500);
  const bodyAfterHelp = await page.evaluate(() => document.body.innerText);
  const helpOpened = bodyAfterHelp.includes("FAQ") || bodyAfterHelp.includes("How") || bodyAfterHelp.includes("Frequently") || bodyAfterHelp.includes("Help") && bodyAfterHelp.includes("ticket");
  console.log("Help Center opened in-app:", helpOpened, "body snippet:", bodyAfterHelp.replace(/\n/g," ").slice(0,80));
  await ss(page, "SET-02-help-center");

  // Go back to Settings
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(btn => { const r = btn.getBoundingClientRect(); return r.x < 80 && r.y < 120 && r.y >= 0 && btn.querySelector("svg"); });
    if (b) { const pk = Object.keys(b).find(k => k.startsWith("__reactProps$")); if (pk && b[pk]?.onClick) b[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}}); else b.click(); }
  });
  await wait(1500);

  // 2. Privacy Policy — opens new tab
  const allTargets = [];
  browser.on("targetcreated", t => allTargets.push(t.url()));
  await rc(page, "Privacy Policy");
  await wait(3000);
  console.log("New tabs after Privacy Policy click:", allTargets);
  await ss(page, "SET-03-after-privacy-click");
  // Take screenshot of new tab if opened
  const allPages = await browser.pages();
  console.log("All pages:", allPages.length, allPages.map(p => p.url()).join(" | "));
  if (allPages.length > 1) {
    const privPage = allPages[allPages.length - 1];
    await privPage.setViewport({width:390,height:844});
    await wait(2000);
    await privPage.screenshot({ path: path.join(OUT, "SET-04-privacy-page.png") });
    console.log("V SET-04-privacy-page, url:", privPage.url());
    await privPage.close();
  }

  // 3. Terms of Use — opens new tab
  await rc(page, "Terms of Use");
  await wait(3000);
  const allPages2 = await browser.pages();
  console.log("All pages after Terms:", allPages2.length, allPages2.map(p => p.url()).join(" | "));
  if (allPages2.length > 1) {
    const termsPage = allPages2[allPages2.length - 1];
    await termsPage.setViewport({width:390,height:844});
    await wait(2000);
    await termsPage.screenshot({ path: path.join(OUT, "SET-05-terms-page.png") });
    console.log("V SET-05-terms-page, url:", termsPage.url());
    await termsPage.close();
  }

  console.log("DONE");
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
