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

  if (!body.includes("Discover Nigeria") || !body.includes("Featured")) {
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
    await waitFor(page, "Events", 10000);
    await wait(2000);
  }

  // Filter bar screenshot (top of home)
  await ss(page, "AFTER-T1-filter-bar");

  // Scroll down to see Explore Events grid
  await page.evaluate(() => window.scrollBy(0, 600));
  await wait(1500);
  await ss(page, "AFTER-T2-event-grid");

  // Scroll back to top, click the featured event card
  await page.evaluate(() => window.scrollTo(0,0));
  await wait(1000);
  const eventTitle = await page.evaluate(() => {
    // Find the featured event carousel card and click it
    const el = document.querySelector("[style*='cursor: pointer']");
    if (el) { el.click(); return "clicked carousel"; }
    return "nothing";
  });
  console.log("event click:", eventTitle);
  await wait(4000);
  body = await page.evaluate(() => document.body.innerText);
  console.log("event detail body:", body.slice(0,200).replace(/\n/g," "));
  await ss(page, "AFTER-T3-event-detail");

  // Scroll down to see Book button
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(1000);
  await ss(page, "AFTER-T4-book-button");

  // Go back and Profile
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => b.getBoundingClientRect().x < 60 && b.getBoundingClientRect().y < 120); if (b) b.click(); else window.history.back(); });
  await wait(2000);
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Profile")?.click());
  await wait(3000);
  body = await page.evaluate(() => document.body.innerText);
  console.log("profile body:", body.slice(0,200).replace(/\n/g," "));
  await ss(page, "AFTER-T5-profile");

  console.log("DONE");
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
