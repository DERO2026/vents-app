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
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(90000);
  await page.goto("https://getvents.com", {waitUntil:"domcontentloaded",timeout:90000});
  await wait(5000);
  let body = await page.evaluate(() => document.body.innerText);
  console.log("initial:", body.slice(0,150).replace(/\n/g," "));

  // Login
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
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Home")?.click());
  await waitFor(page, "Featured", 10000);
  await wait(2000);
  
  // Take filter bar screenshot
  await ss(page, "FINAL-01-home-filterbar");

  // Scroll to show Explore Events section
  await page.evaluate(() => window.scrollBy(0, 500));
  await wait(1500);
  await ss(page, "FINAL-02-explore-grid");

  // Scroll back to top and click on featured event
  await page.evaluate(() => window.scrollTo(0,0));
  await wait(800);

  // Click within the featured carousel image area (center, around y=400 from top of card at y=120 approx)
  await page.mouse.click(195, 400);
  await wait(4000);
  body = await page.evaluate(() => document.body.innerText);
  console.log("detail body:", body.slice(0,200).replace(/\n/g," "));
  await ss(page, "FINAL-03-event-detail-top");
  
  // Scroll to bottom for Book button
  await page.evaluate(() => window.scrollTo(0, 9999));
  await wait(1000);
  await ss(page, "FINAL-04-book-button");

  // Back
  await page.evaluate(() => window.history.back());
  await wait(2000);
  body = await page.evaluate(() => document.body.innerText);
  console.log("after back:", body.slice(0,100).replace(/\n/g," "));

  // Profile tab
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Profile")?.click());
  await wait(4000);
  body = await page.evaluate(() => document.body.innerText);
  console.log("profile body:", body.slice(0,200).replace(/\n/g," "));
  await ss(page, "FINAL-05-profile");

  console.log("DONE");
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
