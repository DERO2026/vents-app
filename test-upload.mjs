// Item 1b: Test upload flow as authenticated organizer
import { createClient } from '@insforge/sdk';

const INSFORGE_URL = 'https://8git8iib.us-east.insforge.app';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTU2NzgtOTBhYi1jZGVmMTIzNDU2NzgiLCJlbWFpbCI6ImFub25AaW5zZm9yZ2UuY29tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTM2NDJ9.pGL76BJ9poIPoKvXsZKA2GD-vjZSveWytiSQ4j9lcz0';

const client = createClient({ baseUrl: INSFORGE_URL, anonKey: ANON_KEY });

// Step 1: Anon call (shows exact 403 body an expired session would get)
console.log('\n--- STEP 1: upload-strategy with anon key ---');
const anonRes = await fetch(`${INSFORGE_URL}/api/storage/buckets/events/upload-strategy`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: 'test.jpg', contentType: 'image/jpeg', size: 1024 }),
});
console.log(`HTTP ${anonRes.status}:`, await anonRes.text());

// Step 2: Sign in as organizer
console.log('\n--- STEP 2: signInWithPassword ---');
const { data: authData, error: authErr } = await client.auth.signInWithPassword({
  email: 'djjackson361@gmail.com',
  password: process.env.TEST_PASSWORD || 'NEEDS_PASSWORD',
});
if (authErr) {
  console.log('Auth error:', authErr.message, authErr.statusCode);
  console.log('\nCannot proceed without valid credentials.');
  console.log('Re-running upload-strategy call to confirm 403 is the auth-expired scenario...');

  // Show what error the SDK would surface
  const { data, error } = await client.storage.from('events').uploadAuto(
    new File([new Uint8Array(100)], 'test.jpg', { type: 'image/jpeg' })
  );
  console.log('SDK uploadAuto result:', { data, error: error ? { message: error.message, code: error.code } : null });
  process.exit(0);
}

const token = authData?.accessToken || authData?.session?.accessToken;
console.log('Signed in. Token prefix:', token?.slice(0, 40));

// Step 3: Call upload-strategy as authenticated user
console.log('\n--- STEP 3: upload-strategy with session token ---');
const stratRes = await fetch(`${INSFORGE_URL}/api/storage/buckets/events/upload-strategy`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: `flier-${Date.now()}.jpg`, contentType: 'image/jpeg', size: 1024 }),
});
const strategy = await stratRes.json();
console.log(`HTTP ${stratRes.status}:`, JSON.stringify(strategy, null, 2));

// Step 4: Test the actual upload path the SDK would take
if (strategy.method === 'presigned' && strategy.uploadUrl) {
  console.log('\n--- STEP 4: Presigned upload ---');
  const fd = new FormData();
  if (strategy.fields) Object.entries(strategy.fields).forEach(([k, v]) => fd.append(k, String(v)));
  fd.append('file', new Blob([new Uint8Array(1024).fill(0xff)], { type: 'image/jpeg' }), 'test.jpg');
  const upRes = await fetch(strategy.uploadUrl, { method: 'POST', body: fd });
  const upText = await upRes.text();
  console.log(`Presigned upload HTTP ${upRes.status}:`, upText.slice(0, 300));

  if (strategy.confirmRequired && strategy.confirmUrl) {
    console.log('\n--- STEP 5: Confirm ---');
    const confRes = await fetch(`${INSFORGE_URL}${strategy.confirmUrl}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: 1024, contentType: 'image/jpeg' }),
    });
    const conf = await confRes.json();
    console.log(`Confirm HTTP ${confRes.status}:`, JSON.stringify(conf, null, 2));
    console.log('Has url field?', !!conf.url, '→ imageUrl would be:', conf.url || 'MISSING — setImageUrl never called!');
  }
} else if (strategy.method === 'direct') {
  console.log('Direct upload path — testing POST /objects...');
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(1024).fill(0xff)], { type: 'image/jpeg' }), 'test.jpg');
  const upRes = await fetch(`${INSFORGE_URL}/api/storage/buckets/events/objects`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: fd,
  });
  const upJson = await upRes.json().catch(() => upRes.text());
  console.log(`Direct upload HTTP ${upRes.status}:`, JSON.stringify(upJson, null, 2));
  console.log('Has url field?', !!(upJson?.url), '→ imageUrl would be:', upJson?.url || 'MISSING');
}
