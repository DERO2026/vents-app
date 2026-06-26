const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=20000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(600); await page.screenshot({ path: path.join(OUT, name+".png") }); console.log("SS: "+name); };

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    defaultViewport: {width:390,height:844},
    args: ["--no-sandbox"],
    userDataDir: "C:\\Temp\\pv-before2"
  });

  // --- Screenshot 1: Home screen filter bar ---
  const p1 = await browser.newPage();
  await p1.goto("https://getvents.com", {waitUntil:"domcontentloaded",timeout:90000});
  await wait(5000);
  await p1.evaluate(() => { const el = [...document.querySelectorAll("*")].find(e => e.textContent.includes("Sign in") && !e.children.length); if (el) el.click(); });
  await wait(3000);
  await p1.evaluate((em, pw) => {
    const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const fill = (el, v) => { if (!el) return; niv.call(el, v); el.dispatchEvent(new Event("input",{bubbles:true})); };
    const inputs = [...document.querySelectorAll("input")];
    fill(inputs.find(i => i.type==="email"||i.type==="text"), em);
    fill(inputs.find(i => i.type==="password"), pw);
  }, "djjackson361@gmail.com", "Dero2026$");
  await wait(500);
  await p1.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.includes("Sign In"))?.click());
  await waitFor(p1, "Home", 25000);
  await wait(2000);
  await p1.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Home")?.click());
  await waitFor(p1, "Featured", 10000);
  await wait(2000);
  await ss(p1, "FINAL-HOME-filterbar");
  
  // Scroll slightly to see cards
  await p1.evaluate(() => window.scrollBy(0, 400));
  await wait(1000);
  await ss(p1, "FINAL-HOME-cards");
  await p1.close();

  // --- Screenshot 2: Event detail (Book button) ---
  const p2 = await browser.newPage();
  await p2.goto("https://getvents.com", {waitUntil:"domcontentloaded",timeout:90000});
  await wait(5000);
  const b2 = await p2.evaluate(() => document.body.innerText);
  if (b2.includes("Sign in") || b2.includes("TAP TO BEGIN")) {
    await p2.evaluate(() => { const el = [...document.querySelectorAll("*")].find(e => e.textContent.includes("Sign in") && !e.children.length); if (el) el.click(); });
    await wait(3000);
    await p2.evaluate((em, pw) => {
      const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const fill = (el, v) => { if (!el) return; niv.call(el, v); el.dispatchEvent(new Event("input",{bubbles:true})); };
      const inputs = [...document.querySelectorAll("input")];
      fill(inputs.find(i => i.type==="email"||i.type==="text"), em);
      fill(inputs.find(i => i.type==="password"), pw);
    }, "djjackson361@gmail.com", "Dero2026$");
    await wait(500);
    await p2.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.includes("Sign In"))?.click());
    await waitFor(p2, "Home", 25000);
    await wait(2000);
  }
  await p2.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Home")?.click());
  await waitFor(p2, "Featured", 10000);
  await wait(2000);
  // Click the featured event card area
  await p2.mouse.click(195, 380);
  await wait(4000);
  const db2 = await p2.evaluate(() => document.body.innerText);
  console.log("detail:", db2.slice(0,100).replace(/\n/g," "));
  // Scroll to bottom to show Book button
  await p2.evaluate(() => window.scrollTo(0, 9999));
  await wait(800);
  await ss(p2, "FINAL-EVENT-book-orange");
  await p2.close();

  // --- Screenshot 3: Profile ---
  const p3 = await browser.newPage();
  await p3.goto("https://getvents.com", {waitUntil:"domcontentloaded",timeout:90000});
  await wait(5000);
  const b3 = await p3.evaluate(() => document.body.innerText);
  if (b3.includes("Sign in") || b3.includes("TAP TO BEGIN")) {
    await p3.evaluate(() => { const el = [...document.querySelectorAll("*")].find(e => e.textContent.includes("Sign in") && !e.children.length); if (el) el.click(); });
    await wait(3000);
    await p3.evaluate((em, pw) => {
      const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const fill = (el, v) => { if (!el) return; niv.call(el, v); el.dispatchEvent(new Event("input",{bubbles:true})); };
      const inputs = [...document.querySelectorAll("input")];
      fill(inputs.find(i => i.type==="email"||i.type==="text"), em);
      fill(inputs.find(i => i.type==="password"), pw);
    }, "djjackson361@gmail.com", "Dero2026$");
    await wait(500);
    await p3.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.includes("Sign In"))?.click());
    await waitFor(p3, "Home", 25000);
    await wait(2000);
  }
  await p3.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Profile")?.click());
  await wait(4000);
  await ss(p3, "FINAL-PROFILE");
  await p3.close();

  console.log("DONE");
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
