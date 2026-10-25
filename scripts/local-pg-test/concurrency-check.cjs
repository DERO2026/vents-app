#!/usr/bin/env node
// Two genuinely overlapping Postgres connections racing the same
// payment_ref through confirm_ticket_payment / its internal FOR UPDATE
// lock. See run-concurrency-verification.sh for the full rationale.
//
// Connection expectations are passed via standard PG* env vars by the
// calling shell script.
const { Client } = require('pg');

const PAYREF_1 = 'PAYREF-CONCURRENT-ABORT';
const PAYREF_2 = 'PAYREF-CONCURRENT-COMMIT';
const ORGANIZER_ID_1 = '00000000-0000-0000-0000-000000000002';
const ORGANIZER_ID_2 = '00000000-0000-0000-0000-000000000003';
const BUYER_ID = '00000000-0000-0000-0000-000000000001';
const EVENT_ID_1 = '10000000-0000-0000-0000-000000000001';
const EVENT_ID_2 = '10000000-0000-0000-0000-000000000002';

function client() {
  return new Client();
}

async function seedCommon(c) {
  await c.query(`
    INSERT INTO auth.users (id, email) VALUES
      ('${BUYER_ID}', 'buyer@test.com'),
      ('${ORGANIZER_ID_1}', 'organizer1@test.com'),
      ('${ORGANIZER_ID_2}', 'organizer2@test.com')
    ON CONFLICT DO NOTHING;
  `);
  await c.query(`
    INSERT INTO public.events (id, organizer_id, title, event_date, status) VALUES
      ('${EVENT_ID_1}', '${ORGANIZER_ID_1}', 'Concurrency Test Event 1', now() + interval '10 days', 'live'),
      ('${EVENT_ID_2}', '${ORGANIZER_ID_2}', 'Concurrency Test Event 2', now() + interval '10 days', 'live')
    ON CONFLICT DO NOTHING;
  `);
}

async function seedOrder(c, payRef, ticketIdPrefix, amounts, eventId) {
  for (let i = 0; i < amounts.length; i++) {
    const id = `${ticketIdPrefix}${String(i + 1).padStart(2, '0')}`;
    await c.query(
      `INSERT INTO public.tickets (id, event_id, user_id, payer_id, quantity, payment_ref, payment_status, amount, ticket_type)
       VALUES ($1, $2, $3, $4, 1, $5, 'pending', $6, 'VIP')`,
      [id, eventId, BUYER_ID, BUYER_ID, payRef, amounts[i]]
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertEqual(actual, expected, label) {
  if (String(actual) !== String(expected)) {
    throw new Error(`FAIL: ${label} -- expected ${expected}, got ${actual}`);
  }
  console.log(`PASS: ${label} (${actual})`);
}

// Scenario 1: connection A takes the lock, holds it, then ROLLS BACK
// without writing anything (simulating an aborted/slow first delivery).
// Connection B's confirm_ticket_payment call is issued WHILE A still holds
// the lock -- it must block, then proceed and succeed exactly once after
// A releases it.
async function scenarioAbortThenSucceed() {
  console.log('\n== Scenario 1: A holds lock + rolls back, B is blocked then succeeds ==');
  const totalAmount = 8000; // 5000 + 3000
  const seed = client();
  await seed.connect();
  await seedCommon(seed);
  await seedOrder(seed, PAYREF_1, '21000000-0000-0000-0000-0000000000', [5000, 3000], EVENT_ID_1);
  await seed.end();

  const connA = client();
  const connB = client();
  await connA.connect();
  await connB.connect();

  await connA.query('BEGIN');
  await connA.query('SELECT 1 FROM public.tickets WHERE payment_ref = $1 FOR UPDATE', [PAYREF_1]);
  console.log('A: lock acquired, holding for 1500ms before rollback');

  // Fire B's real confirm_ticket_payment call WHILE A still holds the lock.
  // Do not await it yet -- it must be genuinely in-flight (blocked on the
  // server) concurrently with A's open transaction.
  const expectedKobo = Math.round(totalAmount * 1.05 * 100);
  const bPromise = connB.query('SELECT public.confirm_ticket_payment($1, $2) AS result', [PAYREF_1, expectedKobo]);

  await sleep(300); // give B's query time to actually reach the server and block
  const inFlight = await connA.query(
    `SELECT count(*) FROM pg_stat_activity
     WHERE state = 'active' AND wait_event_type = 'Lock' AND query ILIKE '%confirm_ticket_payment%'`
  );
  await assertEqual(inFlight.rows[0].count >= 1 ? 'blocked' : 'not_blocked', 'blocked', 'B is genuinely blocked on A\'s lock while A still holds it');

  await sleep(1200);
  await connA.query('ROLLBACK');
  console.log('A: rolled back without writing anything, lock released');

  const bResult = await bPromise;
  await assertEqual(bResult.rows[0].result, 'confirmed', 'B succeeds exactly once after A releases the lock empty-handed');

  const txnCount = await connA.query(
    `SELECT count(*) FROM public.organizer_transactions WHERE metadata->>'paystack_reference' = $1`,
    [PAYREF_1]
  );
  await assertEqual(txnCount.rows[0].count, 1, 'exactly one organizer_transactions row after the race');

  const allocSum = await connA.query(
    `SELECT sum(platform_fee_kobo) AS s FROM public.tickets WHERE payment_ref = $1`,
    [PAYREF_1]
  );
  const buyerFee = await connA.query(
    `SELECT metadata->>'buyer_fee_kobo' AS f FROM public.organizer_transactions WHERE metadata->>'paystack_reference' = $1`,
    [PAYREF_1]
  );
  await assertEqual(allocSum.rows[0].s, buyerFee.rows[0].f, 'allocation sum matches authoritative fee after the race');

  await connA.end();
  await connB.end();
}

// Scenario 2: connection A takes the lock and actually RUNS
// confirm_ticket_payment to completion (commit), while B's call is issued
// concurrently and blocked the entire time. B must then see the
// already-paid ticket and no-op -- no duplicate txn row, no double wallet
// credit, no re-allocation.
async function scenarioCommitThenNoop() {
  console.log('\n== Scenario 2: A commits a real payment while B is blocked, B then no-ops ==');
  const totalAmount = 6000; // 4000 + 2000
  const seed = client();
  await seed.connect();
  await seedCommon(seed);
  await seedOrder(seed, PAYREF_2, '22000000-0000-0000-0000-0000000000', [4000, 2000], EVENT_ID_2);
  await seed.end();

  const connA = client();
  const connB = client();
  await connA.connect();
  await connB.connect();

  const expectedKobo = Math.round(totalAmount * 1.05 * 100);

  await connA.query('BEGIN');
  await connA.query('SELECT 1 FROM public.tickets WHERE payment_ref = $1 FOR UPDATE', [PAYREF_2]);
  console.log('A: lock acquired, will run confirm_ticket_payment then commit after a delay');

  const bPromise = connB.query('SELECT public.confirm_ticket_payment($1, $2) AS result', [PAYREF_2, expectedKobo]);
  await sleep(300); // let B's query actually reach the server and block on A's row lock

  // A still holds the SAME row lock it took manually above; running
  // confirm_ticket_payment on A re-acquires that lock within A's own
  // transaction (no self-block in Postgres), performs the real work, then
  // we commit -- releasing the lock for B.
  const aResult = await connA.query('SELECT public.confirm_ticket_payment($1, $2) AS result', [PAYREF_2, expectedKobo]);
  await assertEqual(aResult.rows[0].result, 'confirmed', 'A completes the real payment confirmation while holding the lock');
  await connA.query('COMMIT');
  console.log('A: committed, lock released');

  const bResult = await bPromise;
  await assertEqual(bResult.rows[0].result, 'already_paid', 'B, unblocked after A commits, sees already-paid and no-ops');

  const txnCount = await connA.query(
    `SELECT count(*) FROM public.organizer_transactions WHERE metadata->>'paystack_reference' = $1`,
    [PAYREF_2]
  );
  await assertEqual(txnCount.rows[0].count, 1, 'no duplicate organizer_transactions row from B');

  const walletBalance = await connA.query(
    `SELECT balance_kobo FROM public.organizer_wallets WHERE organizer_id = $1`,
    [ORGANIZER_ID_2]
  );
  const expectedCredit = Math.floor(totalAmount * 100);
  await assertEqual(walletBalance.rows[0].balance_kobo, expectedCredit, 'wallet credited exactly once, not doubled, for this order');

  const allocSum = await connA.query(
    `SELECT sum(platform_fee_kobo) AS s FROM public.tickets WHERE payment_ref = $1`,
    [PAYREF_2]
  );
  const buyerFee = await connA.query(
    `SELECT metadata->>'buyer_fee_kobo' AS f FROM public.organizer_transactions WHERE metadata->>'paystack_reference' = $1`,
    [PAYREF_2]
  );
  await assertEqual(allocSum.rows[0].s, buyerFee.rows[0].f, 'fee allocation is not re-run or doubled by B');

  await connA.end();
  await connB.end();
}

(async () => {
  try {
    await scenarioAbortThenSucceed();
    await scenarioCommitThenNoop();
    console.log('\nALL CONCURRENCY SCENARIOS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('\n' + (err && err.message ? err.message : err));
    process.exit(1);
  }
})();
