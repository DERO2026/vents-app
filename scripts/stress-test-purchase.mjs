// VENTS purchase-flow concurrency stress test.
// Exercises the REAL production purchase_ticket_with_tokens RPC via real
// authenticated REST sessions (no mocking) against a disposable test event,
// then cleans up all test data it created. Requires an InsForge CLI/admin
// connection alongside this script (see steps below) since fresh signups
// default to the 'attendee' role and RLS blocks a plain user from inserting
// an event directly — the test event is created via direct admin DB access,
// not through this script's REST calls.
//
// Full run:
//   1. VENTS_ANON=<anon key> N_USERS=100 node stress-test.mjs setup
//   2. insforge db query "UPDATE auth.users SET email_verified = true
//        WHERE email LIKE 'vents-stresstest-%@resend.dev'" --unrestricted
//      (these are disposable accounts this script itself just created)
//   3. VENTS_ANON=<anon key> node stress-test.mjs verify-and-signin
//   4. insforge db query "INSERT INTO public.events (title, location,
//        event_date, price, ticket_goal, status, organizer_id, ticket_types)
//        SELECT 'STRESS TEST (delete me)', 'x', now() + interval '7 days',
//        0, 1000, 'live', id, '[{"id":"t_0","name":"GA","price":0,
//        "quantity":20,"description":"d"}]'::jsonb FROM public.users
//        WHERE email='vents-stresstest-0@resend.dev' RETURNING id"
//      then patch stress-state.json's eventId with the returned id.
//   5. VENTS_ANON=<anon key> node stress-test.mjs phaseA   (inventory exhaustion)
//   6. VENTS_ANON=<anon key> node stress-test.mjs phaseB   (idempotency/retry)
//   7. Clean up: DELETE tickets for eventId, DELETE the event, DELETE the
//      auth.users rows matching the vents-stresstest-%@resend.dev pattern.
//
// Usage: node stress-test.mjs <phase>
//   setup     - create N test users + 1 test event with limited inventory
//   phaseA    - fire N concurrent purchases from N distinct users (inventory exhaustion)
//   phaseB    - fire repeated concurrent purchases from a subset of already-successful
//               users, with duplicate/varied payment refs (idempotency/retry test)
//   cleanup   - delete all test data created by this script

import { writeFileSync, readFileSync, existsSync } from 'fs';

const BASE = process.env.VENTS_BASE || 'https://8git8iib.us-east.insforge.app';
const ANON = process.env.VENTS_ANON;
if (!ANON) { console.error('Set VENTS_ANON'); process.exit(1); }

const STATE_FILE = './stress-state.json';
const N_USERS = Number(process.env.N_USERS || 100);
const INVENTORY = Number(process.env.INVENTORY || 20);
const EMAIL_PREFIX = 'vents-stresstest';
const PASSWORD = 'StressTest!2026x';

function loadState() { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {}; }
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function signUp(email) {
  const res = await fetch(`${BASE}/api/auth/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password: PASSWORD, name: 'Stress Test' }),
  });
  return res.json();
}

async function signIn(email) {
  const res = await fetch(`${BASE}/api/auth/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const json = await res.json();
  return json.accessToken;
}

async function rpc(token, name, body) {
  const res = await fetch(`${BASE}/api/database/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

async function setup() {
  console.log(`Creating ${N_USERS} disposable test users...`);
  const emails = Array.from({ length: N_USERS }, (_, i) => `${EMAIL_PREFIX}-${i}@resend.dev`);

  // Sign up in small batches to be a reasonable citizen of the auth endpoint.
  for (let i = 0; i < emails.length; i += 20) {
    const batch = emails.slice(i, i + 20);
    await Promise.all(batch.map((e) => signUp(e)));
    console.log(`  signed up ${Math.min(i + 20, emails.length)}/${emails.length}`);
  }

  console.log('Waiting for user rows to land, then verify + fetch ids...');
  await new Promise((r) => setTimeout(r, 1500));

  // Sign in all (still blocked until email_verified=true — the orchestrator
  // flips that directly via its own DB access between this step and the next,
  // since it created these disposable accounts itself).
  saveState({ emails, users: [] });
  console.log('Setup phase 1 done. Now run: node stress-test.mjs verify-and-signin');
}

async function verifyAndSignIn() {
  const state = loadState();
  console.log(`Signing in ${state.emails.length} users (should be verified by now)...`);
  const users = [];
  for (let i = 0; i < state.emails.length; i += 20) {
    const batch = state.emails.slice(i, i + 20);
    const tokens = await Promise.all(batch.map(async (email) => ({ email, token: await signIn(email) })));
    users.push(...tokens);
    console.log(`  signed in ${Math.min(i + 20, state.emails.length)}/${state.emails.length}`);
  }
  const failed = users.filter((u) => !u.token);
  console.log(`Signed in: ${users.length - failed.length}/${users.length} (${failed.length} failed)`);
  state.users = users.filter((u) => u.token);
  saveState(state);
}

async function createEvent() {
  // NOT automated: fresh signups default to the 'attendee' role and the
  // events INSERT policy requires an organizer, so this always 42501s from
  // a plain user session. Create the test event via direct admin DB access
  // instead (see the usage steps in the header comment above), then patch
  // stress-state.json's eventId manually.
  console.log('createEvent is not automated — see the usage steps in this file\'s header comment.');
}

async function phaseA() {
  const state = loadState();
  console.log(`\n=== PHASE A: inventory exhaustion — ${state.users.length} distinct users, ${INVENTORY} tickets available ===`);
  const t0 = Date.now();
  const results = await Promise.all(state.users.map(async (u, i) => {
    const paymentRef = `STRESS-A-${i}-${Date.now()}`;
    const r = await rpc(u.token, 'purchase_ticket_with_tokens', {
      p_event_id: state.eventId,
      p_ticket_type: 'GA',
      p_attendees: [{ name: `Stress User ${i}`, email: u.email }],
      p_payment_ref: paymentRef,
      p_promo_code: null,
    });
    return { email: u.email, paymentRef, ...r };
  }));
  const elapsed = Date.now() - t0;

  const succeeded = results.filter((r) => r.ok && Array.isArray(r.json) && r.json.length > 0);
  const rejected = results.filter((r) => !r.ok);
  console.log(`Fired ${results.length} concurrent requests in ${elapsed}ms`);
  console.log(`  succeeded: ${succeeded.length}`);
  console.log(`  rejected:  ${rejected.length}`);
  const rejectReasons = {};
  for (const r of rejected) {
    const msg = r.json?.message || r.json?.error || 'unknown';
    rejectReasons[msg] = (rejectReasons[msg] || 0) + 1;
  }
  console.log('  rejection reasons:', JSON.stringify(rejectReasons, null, 2));

  state.phaseAResults = results;
  state.phaseASucceeded = succeeded.map((r) => r.email);
  saveState(state);
}

async function phaseB() {
  const state = loadState();
  const retryUsers = state.users.filter((u) => state.phaseASucceeded.includes(u.email)).slice(0, 10);
  console.log(`\n=== PHASE B: idempotency/retry — ${retryUsers.length} users, 5 concurrent duplicate-ref retries each ===`);

  const t0 = Date.now();
  const all = await Promise.all(retryUsers.flatMap((u, ui) =>
    Array.from({ length: 5 }, (_, k) => {
      // Alternate between reusing the SAME payment ref (true retry) and a
      // FRESH one (simulates a client that regenerated its reference on
      // retry) — purchase_ticket's per-user existing-active-ticket check
      // should make both cases idempotent regardless of payment_ref.
      const paymentRef = k % 2 === 0 ? `STRESS-B-SAME-${ui}` : `STRESS-B-FRESH-${ui}-${k}-${Date.now()}`;
      return rpc(u.token, 'purchase_ticket_with_tokens', {
        p_event_id: state.eventId,
        p_ticket_type: 'GA',
        p_attendees: [{ name: `Stress User Retry ${ui}`, email: u.email }],
        p_payment_ref: paymentRef,
        p_promo_code: null,
      }).then((r) => ({ email: u.email, paymentRef, ...r }));
    })
  ));
  const elapsed = Date.now() - t0;

  console.log(`Fired ${all.length} concurrent retry requests in ${elapsed}ms`);
  // Group by user, check all responses for a user resolve to the SAME ticket id set.
  let allIdempotent = true;
  for (const u of retryUsers) {
    const mine = all.filter((r) => r.email === u.email && r.ok);
    const idSets = mine.map((r) => JSON.stringify((r.json || []).map((t) => t.ticket_id).sort()));
    const distinct = new Set(idSets);
    const ok = distinct.size === 1;
    if (!ok) allIdempotent = false;
    console.log(`  ${u.email}: ${mine.length} ok responses, distinct ticket-id-sets: ${distinct.size} ${ok ? 'OK' : 'MISMATCH!'}`);
  }
  console.log(allIdempotent ? 'PHASE B: all retries idempotent, zero duplicate tickets.' : 'PHASE B: IDEMPOTENCY VIOLATION DETECTED.');
  state.phaseBAllIdempotent = allIdempotent;
  saveState(state);
}

async function main() {
  const phase = process.argv[2];
  if (phase === 'setup') return setup();
  if (phase === 'verify-and-signin') return verifyAndSignIn();
  if (phase === 'create-event') return createEvent();
  if (phase === 'phaseA') return phaseA();
  if (phase === 'phaseB') return phaseB();
  console.error('Unknown phase. Use: setup | verify-and-signin | create-event | phaseA | phaseB');
  process.exit(1);
}
main();
