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

  // Click "Sign in" leaf node (approach from working screenshot-before.cjs)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find(e => e.textContent.includes("Sign in") && !e.children.length);
    if (el) { console.log("found sign in:", el.tagName, el.textContent); el.click(); }
    else console.log("sign in not found");
  });
  await wait(3000);

  let body = await page.evaluate(() => document.body.innerText);
  console.log("after click:", body.slice(0,200).replace(/\n/g," "));

  // Fill inputs
  await page.evaluate((em, pw) => {
    const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const fill = (el, v) => { if (!el) return; niv.call(el, v); el.dispatchEvent(new Event("input",{bubbles:true})); };
    const inputs = [...document.querySelectorAll("input")];
    console.log("inputs found:", inputs.length, inputs.map(i => i.type).join(","));
    fill(inputs.find(i => i.type==="email"||i.type==="text"), em);
    fill(inputs.find(i => i.type==="password"), pw);
  }, "djjackson361@gmail.com", "Dero2026$");
  await wait(500);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(b => b.textContent.includes("Sign In"));
    if (b) { console.log("found sign in btn:", b.textContent); b.click(); }
    else console.log("no sign in btn");
  });
  const ok = await waitFor(page, "Home", 25000);
  console.log("home found:", ok);
  await wait(2000);

  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Home")?.click());
  const feat = await waitFor(page, "Events", 10000);
  console.log("events found:", feat);
  await wait(2000);

  body = await page.evaluate(() => document.body.innerText);
  console.log("home body:", body.slice(0,200).replace(/\n/g," "));

  await ss(page, "AFTER-01-home");
  await page.evaluate(() => window.scrollBy(0, 120));
  await wait(1200);
  await ss(page, "AFTER-02-filter-and-cards");

  // Click a card
  const clickedCard = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("div")].filter(d => {
      const r = d.getBoundingClientRect(); const t = d.innerText||'';
      return r.width > 150 && r.height > 100 && r.height < 350 && (t.includes('₦') || t.includes('Free'));
    });
    if (cards.length) { cards[0].click(); return "clicked"; }
    return "none";
  });
  console.log("card click:", clickedCard);
  await wait(4000);
  await ss(page, "AFTER-03-event-detail");

  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => b.getBoundingClientRect().x < 60 && b.getBoundingClientRect().y < 120); if (b) b.click(); else window.history.back(); });
  await wait(2000);
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Profile")?.click());
  await wait(3000);
  await ss(page, "AFTER-04-profile");

  console.log("DONE");
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
