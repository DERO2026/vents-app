const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=8000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(1000); await page.screenshot({ path: path.join(OUT, name+".png") }); console.log("V "+name); };

const clickLabel = async (page, label) => {
  const found = await page.evaluate(l => {
    const all = [...document.querySelectorAll("button, [role=button], a")];
    for (const el of all) {
      if (el.textContent.includes(l)) {
        const pk = Object.keys(el).find(k => k.startsWith("__reactProps$"));
        if (pk && el[pk]?.onClick) { el[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}}); return true; }
        el.click(); return true;
      }
    }
    // fallback: any element containing exactly this label
    const span = [...document.querySelectorAll("*")].find(e => e.textContent.trim() === l);
    if (span) { span.click(); return "span"; }
    return false;
  }, label);
  return found;
};

const goBack = async (page) => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(btn => {
      const r = btn.getBoundingClientRect();
      return r.x < 80 && r.y < 120 && r.y >= 0 && btn.querySelector("svg");
    });
    if (!b) return;
    const pk = Object.keys(b).find(k => k.startsWith("__reactProps$"));
    if (pk && b[pk]?.onClick) b[pk].onClick({type:"click",preventDefault:()=>{},stopPropagation:()=>{}});
    else b.click();
  });
  await wait(1200);
};

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    defaultViewport: {width:390,height:844},
    args: ["--no-sandbox"],
    userDataDir: "C:\\Temp\\pv-set2-"+Date.now()
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

  // Navigate to Settings
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Profile")?.click());
  await wait(1500);
  await clickLabel(page, "Settings");
  await waitFor(page, "Privacy Policy", 5000) || await waitFor(page, "Help Center", 5000);
  await wait(800);
  // Scroll to SUPPORT & LEGAL section
  await page.evaluate(() => {
    const els = [...document.querySelectorAll("*")].filter(e => e.textContent.includes("SUPPORT") && e.getBoundingClientRect().height < 30);
    if (els[0]) els[0].scrollIntoView({block:"center"});
    else { const d = document.querySelector('[style*="overflow"]'); if (d) d.scrollTop = d.scrollHeight; }
  });
  await wait(800);
  await ss(page, "SET-01-settings-main");

  // --- 1. Help Center ---
  const r1 = await clickLabel(page, "Help Center");
  console.log("Help Center click result:", r1);
  await wait(2000);
  const bodyHelp = await page.evaluate(() => document.body.innerText);
  console.log("After Help Center click:", bodyHelp.replace(/\n/g," ").slice(0,120));
  await ss(page, "SET-02-help-center-opened");

  // Back to settings
  await goBack(page);
  await wait(800);
  // Scroll back down
  await page.evaluate(() => {
    const els = [...document.querySelectorAll("*")].filter(e => e.textContent.includes("SUPPORT") && e.getBoundingClientRect().height < 30);
    if (els[0]) els[0].scrollIntoView({block:"center"});
  });
  await wait(600);

  // --- 2. Privacy Policy (opens new tab) ---
  const newTabPromise = new Promise(resolve => browser.once("targetcreated", resolve));
  await clickLabel(page, "Privacy Policy");
  const target = await Promise.race([newTabPromise, wait(4000).then(() => null)]);
  if (target) {
    const privPage = await target.page();
    if (privPage) {
      await privPage.setViewport({width:390,height:844});
      await wait(2500);
      await privPage.screenshot({ path: path.join(OUT, "SET-03-privacy-new-tab.png") });
      console.log("V SET-03-privacy-new-tab, url:", privPage.url());
      await privPage.close();
    }
  } else {
    console.log("Privacy Policy: no new tab, screenshot current page");
    await ss(page, "SET-03-privacy-current");
  }
  await wait(500);

  // Scroll back to SUPPORT section
  await page.evaluate(() => {
    const els = [...document.querySelectorAll("*")].filter(e => e.textContent.includes("SUPPORT") && e.getBoundingClientRect().height < 30);
    if (els[0]) els[0].scrollIntoView({block:"center"});
  });
  await wait(600);

  // --- 3. Terms of Use (opens new tab) ---
  const newTabPromise2 = new Promise(resolve => browser.once("targetcreated", resolve));
  await clickLabel(page, "Terms of Use");
  const target2 = await Promise.race([newTabPromise2, wait(4000).then(() => null)]);
  if (target2) {
    const termsPage = await target2.page();
    if (termsPage) {
      await termsPage.setViewport({width:390,height:844});
      await wait(2500);
      await termsPage.screenshot({ path: path.join(OUT, "SET-04-terms-new-tab.png") });
      console.log("V SET-04-terms-new-tab, url:", termsPage.url());
      await termsPage.close();
    }
  } else {
    console.log("Terms of Use: no new tab, screenshot current page");
    await ss(page, "SET-04-terms-current");
  }

  console.log("DONE");
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message, e.stack?.slice(0,300)); process.exit(1); });
