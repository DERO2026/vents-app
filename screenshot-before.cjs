const puppeteer = require("puppeteer");
const path = require("path");
const OUT = path.join(__dirname, "screenshots");
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (page, text, ms=15000) => { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } };
const ss = async (page, name) => { await wait(800); await page.screenshot({ path: path.join(OUT, name+".png") }); console.log("SCREENSHOT: "+name); };

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    defaultViewport: {width:390,height:844},
    args: ["--no-sandbox", "--disable-web-security"],
    userDataDir: "C:\\Temp\\pv-before2"
  });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(90000);
  await page.goto("https://getvents.com", {waitUntil:"networkidle2",timeout:90000});
  await wait(5000);

  // Check if logged in
  const body = await page.evaluate(() => document.body.innerText);
  console.log("body snippet:", body.slice(0,200).replace(/\n/g," "));

  // Login if needed
  if (!body.includes("Home") || body.includes("Sign In") || body.includes("Get Started")) {
    console.log("Need to login...");
    const signInBtn = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button,a")];
      const b = btns.find(b => b.textContent.includes("Sign In") || b.textContent.includes("Sign in") || b.textContent.includes("Log In"));
      if (b) { b.click(); return true; }
      return false;
    });
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
    await waitFor(page, "Home", 20000);
    await wait(3000);
  }

  await ss(page, "BEFORE-01-home");

  // Click first visible event card
  const clicked = await page.evaluate(() => {
    const allDivs = [...document.querySelectorAll("div")].filter(d => {
      const r = d.getBoundingClientRect();
      const txt = (d.innerText||'');
      return r.width > 200 && r.height > 100 && r.height < 400 && (txt.includes('Book') || txt.includes('₦') || txt.includes('Free'));
    });
    if (allDivs[0]) { allDivs[0].click(); return "clicked card"; }
    return "no card";
  });
  console.log("event click:", clicked);
  await wait(4000);
  await ss(page, "BEFORE-02-event-detail");

  // Back to home
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(b => b.querySelector("svg") && b.getBoundingClientRect().x < 50 && b.getBoundingClientRect().y < 100);
    if (b) b.click(); else window.history.back();
  });
  await wait(2000);

  // Go to Profile
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.trim()==="Profile")?.click());
  await wait(3000);
  await ss(page, "BEFORE-03-profile");

  console.log("DONE");
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message, e.stack?.slice(0,300)); process.exit(1); });
