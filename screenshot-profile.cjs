const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=20000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(600); await page.screenshot({ path: path.join(OUT, name+".png") }); console.log("SS: "+name); };

async function login(page) {
  await page.evaluate(() => { const el = [...document.querySelectorAll("*")].find(e => e.textContent.includes("Sign in") && !e.children.length); if (el) el.click(); });
  await wait(3000);
  await page.evaluate((em, pw) => {
    const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const fill = (el, v) => { if (!el) return; niv.call(el, v); el.dispatchEvent(new Event("input",{bubbles:true})); };
    const inputs = [...document.querySelectorAll("input")];
    fill(inputs.find(i => i.type==="email"||i.type==="text"), em);
    fill(inputs.find(i => i.type==="password"), pw);
  }, "djjackson361@gmail.com", "Dero2026$");
  await wait(500);
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.includes("Sign In"))?.click());
  await waitFor(page, "Home", 25000);
  await wait(2000);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    defaultViewport: {width:390,height:844},
    args: ["--no-sandbox"],
    userDataDir: "C:\\Temp\\pv-before2"
  });
  
  // Page 1: Home + filter bar
  const page1 = await browser.newPage();
  await page1.goto("https://getvents.com", {waitUntil:"domcontentloaded",timeout:90000});
  await wait(5000);
  await login(page1);
  await page1.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Home")?.click());
  await waitFor(page1, "Featured", 10000);
  await wait(2000);
  await ss(page1, "PROFILE-T1-home-clean");
  await page1.close();

  // Page 2: Profile (fresh navigation)
  const page2 = await browser.newPage();
  await page2.goto("https://getvents.com", {waitUntil:"domcontentloaded",timeout:90000});
  await wait(5000);
  let body = await page2.evaluate(() => document.body.innerText);
  if (body.includes("Sign in") || body.includes("TAP TO BEGIN")) {
    await login(page2);
  }
  await page2.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Profile")?.click());
  await wait(4000);
  body = await page2.evaluate(() => document.body.innerText);
  console.log("profile:", body.slice(0,200).replace(/\n/g," "));
  await ss(page2, "PROFILE-T2-profile-badge");
  await page2.close();

  console.log("DONE");
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
