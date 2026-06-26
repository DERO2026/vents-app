// Quick admin login test with different password variations
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'screenshots');

const ROOT_EMAIL = 'ventsappltd@gmail.com';
const PASSWORDS = ['Vents2024!', 'Vents2024$', 'Vents2025!', 'vents2024!', 'Vents2024#', 'Vents@2024'];

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function ss(page, name) {
  await wait(2000);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    defaultViewport: { width: 390, height: 844 },
    args: ['--window-size=430,900','--no-sandbox','--incognito'],
    userDataDir: 'C:\\Temp\\puppeteer-admin-test',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });

  await page.goto('https://getvents.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('button').length > 0, { timeout: 30000 });
  await wait(3000);

  // Click Sign in on splash
  const body = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  console.log('Initial body:', body.slice(0,50));
  if (body.includes('get started') || body.includes('discover')) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Sign in' && !e.children.length);
      if (el) el.click();
    });
    await wait(2000);
  }

  const niv = await page.evaluate(() => typeof Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set);
  console.log('Native setter:', niv);

  for (const pass of PASSWORDS) {
    console.log(`\nTrying: ${ROOT_EMAIL} / ${pass}`);
    await page.evaluate((e, p) => {
      const niv = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const fill = (el, v) => { if (!el) return; niv.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
      fill(document.querySelector('input[type="text"]'), e);
      fill(document.querySelector('input[type="password"]'), p);
    }, ROOT_EMAIL, pass);
    await wait(500);

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Sign In');
      if (btn) btn.click();
    });
    await wait(4000);

    const resultBody = await page.evaluate(() => document.body.innerText);
    const isLoggedIn = resultBody.includes('Home') && !resultBody.includes('Sign In') && !resultBody.includes('Incorrect');
    const isError = resultBody.toLowerCase().includes('incorrect') || resultBody.toLowerCase().includes('invalid') || resultBody.toLowerCase().includes('wrong');
    console.log(`  Result: ${isLoggedIn ? '✓ LOGGED IN' : isError ? '✗ Wrong password' : '? ' + resultBody.slice(0,40)}`);

    if (isLoggedIn) {
      await ss(page, 'K-admin-logged-in');
      // Go to profile to find Admin Console
      await page.evaluate(() => {
        [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Profile')?.click();
      });
      await wait(1500);
      await ss(page, 'K-admin-profile');
      // Admin Console
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Admin'));
        if (btn) btn.click();
      });
      await wait(2000);
      await ss(page, 'K-admin-dashboard');
      const adminBody = await page.evaluate(() => document.body.innerText);
      console.log('Admin dashboard body:', adminBody.slice(0,200).replace(/\n/g,' '));
      // Click Reports tab
      await page.evaluate(() => {
        [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Reports')?.click();
      });
      await wait(1500);
      await ss(page, 'K-admin-reports');
      // Click Payouts tab
      await page.evaluate(() => {
        [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Payouts')?.click();
      });
      await wait(1500);
      await ss(page, 'K-admin-payouts');
      console.log('SUCCESS with password:', pass);
      break;
    }

    // If wrong pass, clear and try again (stay on auth screen)
    const onAuth = resultBody.includes('Sign In') || resultBody.includes('Incorrect');
    if (!onAuth) {
      // Navigate back to auth
      await page.goto('https://getvents.com', { waitUntil: 'domcontentloaded' });
      await wait(3000);
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim()==='Sign in' && !e.children.length);
        if (el) el.click();
      });
      await wait(2000);
    }
  }

  await browser.close();
  console.log('\nDone.');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
