// Admin Console only - now we know the button is "Admin Dashboard"
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'screenshots');

const ROOT_EMAIL = 'ventsappltd@gmail.com';
const ROOT_PASS  = 'Vents2024!';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function ss(page, name) { await wait(2200); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log(`  ✓ ${name}.png`); }
async function waitFor(page, text, ms=10000) { try { await page.waitForFunction(t => document.body.innerText.includes(t), {timeout:ms}, text); return true; } catch { return false; } }
async function getBody(page) { return page.evaluate(() => document.body.innerText); }

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 390, height: 844 },
    args: ['--window-size=430,900','--no-sandbox'],
    userDataDir: 'C:\\Temp\\puppeteer-admin-test', // fresh session for admin
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });

  try {
    await page.goto('https://getvents.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('button').length > 0, { timeout: 30000 });
    await wait(4000);

    // Login
    const bl = (await getBody(page)).toLowerCase();
    if (bl.includes('get started') || bl.includes('discover')) {
      await page.evaluate(() => [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Sign in' && !e.children.length)?.click());
      await wait(2000);
    }
    await page.evaluate((e,p) => {
      const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const fill = (el,v) => { if(!el)return; niv.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
      fill(document.querySelector('input[type="text"]'), e);
      fill(document.querySelector('input[type="password"]'), p);
    }, ROOT_EMAIL, ROOT_PASS);
    await wait(400);
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Sign In')?.click());
    const ok = await waitFor(page, 'Home', 15000);
    console.log('Admin login:', ok ? '✓' : '✗');
    if (!ok) { await ss(page, 'O-login-fail'); await browser.close(); return; }
    await wait(2000);
    await ss(page, 'O-admin-home');

    // Go to Profile
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Profile')?.click());
    await wait(1500);
    await ss(page, 'O-admin-profile-top');

    // Scroll until "Admin Dashboard" button is visible
    let found = false;
    for (let i = 0; i < 25; i++) {
      const check = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const btn = btns.find(b => b.textContent.trim() === 'Admin Dashboard');
        if (btn) {
          const r = btn.getBoundingClientRect();
          // Check it's within viewport
          if (r.top > 0 && r.top < window.innerHeight) return 'visible';
          return 'found-but-hidden';
        }
        return null;
      });
      if (check === 'visible') { found = true; break; }
      if (check === 'found-but-hidden') {
        // Scroll to it
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Admin Dashboard');
          btn?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        await wait(500);
        found = true;
        break;
      }
      // Scroll down
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')].filter(e => {
          const s=window.getComputedStyle(e);
          return (s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;
        }).sort((a,b)=>b.scrollHeight-a.scrollHeight);
        if (els[0]) els[0].scrollBy(0, 100);
        else window.scrollBy(0, 100);
      });
      await wait(200);
    }
    console.log('Admin Dashboard button found:', found);
    if (found) {
      await ss(page, 'O-profile-admin-btn');
      // Click it
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Admin Dashboard');
        if (btn) {
          const pk = Object.keys(btn).find(k => k.startsWith('__reactProps$'));
          if (pk && btn[pk]?.onClick) btn[pk].onClick({ type:'click', preventDefault:()=>{}, stopPropagation:()=>{} });
          else btn.click();
        }
      });
      await waitFor(page, 'Admin Console', 6000) || await waitFor(page, 'Revenue', 5000) || await waitFor(page, 'Reports', 5000);
      await wait(800);
      await ss(page, 'O-admin-dashboard');
      const adminBody = (await getBody(page)).slice(0,300);
      console.log('Admin dashboard body:', adminBody.replace(/\n/g,' ').slice(0,200));

      // Scroll to see stat cards
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')].filter(e=>{const s=window.getComputedStyle(e);return(s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
        els[0]?.scrollBy(0, 300);
      });
      await wait(800);
      await ss(page, 'O-admin-stats');

      // Scroll back to top for tabs
      await page.evaluate(() => {
        const els=[...document.querySelectorAll('*')].filter(e=>{const s=window.getComputedStyle(e);return(s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+10;}).sort((a,b)=>b.scrollHeight-a.scrollHeight);
        els[0]?.scrollTo(0,0);
      });
      await wait(500);

      // Click each tab and screenshot
      for (const tab of ['Reports', 'Users', 'Events', 'Payouts']) {
        const clicked = await page.evaluate((t) => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t);
          if (btn) { btn.click(); return true; }
          return false;
        }, tab);
        if (clicked) {
          await wait(1200);
          await ss(page, `O-admin-${tab.toLowerCase()}`);
          const tb = (await getBody(page)).slice(0,150);
          console.log(`  ${tab} tab:`, tb.replace(/\n/g,' ').slice(0,80));
        }
      }
    } else {
      await ss(page, 'O-no-admin-btn');
      const profileBody = await getBody(page);
      console.log('Profile body:', profileBody.slice(0,300).replace(/\n/g,' '));
    }

    console.log('\n=== Done ===');
  } catch(e) {
    console.error('FATAL:', e.message);
    try { await ss(page, 'O-fatal'); } catch {}
  } finally {
    await browser.close();
  }
})();
