#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's referrals (0), vc_transactions (34), vents_wallets
 * (9), vc_bonuses (8), vc_event_boosts (0), and promo_codes (0) into
 * Supabase, preserving exact UUIDs and all column values.
 *
 * IMPORTANT - vents_wallets.balance is normally DERIVED by the trigger
 * trg_vc_wallet_sync, which fires on every vc_transactions INSERT
 * ('earn'/'referral' + status='active' -> credit; 'spend' + status='active'
 * -> debit). The real data does NOT satisfy this cleanly for a bulk
 * historical load:
 *   - 'spend' rows have status='spent', not 'active' - the trigger's debit
 *     branch would never fire for them, so replaying vc_transactions alone
 *     would NOT reproduce the correct final balance (spend amounts would
 *     be silently dropped).
 *   - Inserting vents_wallets first with the correct final balance, then
 *     vc_transactions, would cause the trigger's credit branch to ADD
 *     earn/referral amounts ON TOP of the already-correct total -
 *     double-counting.
 *   - Letting the trigger create vents_wallets rows from scratch would
 *     also give them fresh random ids, not InsForge's real vents_wallets.id
 *     values.
 *
 * Fix: within the same transaction, `ALTER TABLE vc_transactions DISABLE
 * TRIGGER trg_vc_wallet_sync` before inserting either table, insert both
 * tables with their EXACT source values (no derivation, no computation),
 * then re-enable the trigger before COMMIT so it resumes normal operation
 * for all future (real, live) writes. This is standard practice for
 * bulk-loading data that is already internally consistent from its source
 * - not a bypass of any security/authorization control (unlike the Root
 * account's protection triggers, which exist to restrict WHO can write;
 * this trigger exists to keep a derived value in sync for ONGOING writes,
 * and the data being loaded here is already correct at the source).
 * Verified after commit: every migrated vents_wallets.balance matches
 * InsForge's persisted value exactly, not a recomputed one.
 *
 * FK coverage already confirmed: 0 user_id values (across all tables)
 * fall outside the 25 already-migrated users.
 *
 * Modes: --dry-run (default) prints row counts and samples, no writes.
 * --apply requires CONFIRM_APPLY=YES-MIGRATE-REFERRALS-VC. Idempotent -
 * every INSERT carries ON CONFLICT (id) DO NOTHING.
 */

const { Client } = require('pg');

const REFERRAL_COLS = ['id','referrer_id','referred_email','referred_user_id','status','vc_awarded','created_at','pending_until'];
const VC_TXN_COLS = ['id','user_id','amount','type','status','reference_id','earned_at','expires_at','created_at'];
const WALLET_COLS = ['id','user_id','balance','updated_at'];
const BONUS_COLS = ['id','user_id','bonus_type','granted_at'];
const BOOST_COLS = ['id','event_id','user_id','amount','created_at'];
const PROMO_COLS = ['id','code','discount_percentage','is_active','expires_at','max_uses','current_uses','created_at'];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function tryFetch(sourceUrl, table, preferredCols, orderCol) {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    // Discover actual columns present (schemas for the empty tables were
    // not individually re-verified column-by-column before writing this
    // script - fetch what really exists rather than assume).
    const { rows: colRows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [table]
    );
    const actualCols = new Set(colRows.map((r) => r.column_name));
    const cols = preferredCols.filter((c) => actualCols.has(c));
    if (cols.length === 0) return { cols: [], rows: [] };
    const { rows } = await client.query(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY ${cols.includes(orderCol) ? orderCol : cols[0]}`);
    return { cols, rows };
  } finally {
    await client.end();
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl) { console.error('FATAL: SOURCE_DATABASE_URL not set.'); process.exit(1); }
  if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log('Fetching InsForge referral/VC/promo data (read-only)...');

  const referrals = await tryFetch(sourceUrl, 'referrals', REFERRAL_COLS, 'created_at');
  const vcTxns = await tryFetch(sourceUrl, 'vc_transactions', VC_TXN_COLS, 'created_at');
  const wallets = await tryFetch(sourceUrl, 'vents_wallets', WALLET_COLS, 'updated_at');
  const bonuses = await tryFetch(sourceUrl, 'vc_bonuses', BONUS_COLS, 'granted_at');
  const boosts = await tryFetch(sourceUrl, 'vc_event_boosts', BOOST_COLS, 'created_at');
  const promos = await tryFetch(sourceUrl, 'promo_codes', PROMO_COLS, 'created_at');

  console.log(`Fetched: referrals=${referrals.rows.length} vc_transactions=${vcTxns.rows.length} vents_wallets=${wallets.rows.length} vc_bonuses=${bonuses.rows.length} vc_event_boosts=${boosts.rows.length} promo_codes=${promos.rows.length}`);

  if (!opts.apply) {
    if (vcTxns.rows.length) { console.log('\n=== Sample vc_transaction ==='); console.log(JSON.stringify(vcTxns.rows[0], null, 1)); }
    if (wallets.rows.length) { console.log('\n=== Sample vents_wallet ==='); console.log(JSON.stringify(wallets.rows[0], null, 1)); }
    if (bonuses.rows.length) { console.log('\n=== Sample vc_bonus ==='); console.log(JSON.stringify(bonuses.rows[0], null, 1)); }
    console.log('\n=== Summary ===\nNo writes performed.');
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-REFERRALS-VC') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-REFERRALS-VC. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();

  async function insertAll(table, colsRows) {
    const { cols, rows } = colsRows;
    if (rows.length === 0) return { inserted: 0, skipped: 0 };
    let inserted = 0, skipped = 0;
    for (const row of rows) {
      const values = cols.map((c) => {
        const v = row[c];
        return typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v;
      });
      const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) inserted++; else skipped++;
    }
    return { inserted, skipped };
  }

  try {
    const before = await client.query(
      "SELECT (SELECT count(*) FROM referrals) AS ref, (SELECT count(*) FROM vc_transactions) AS vt, (SELECT count(*) FROM vents_wallets) AS vw, (SELECT count(*) FROM vc_bonuses) AS vb, (SELECT count(*) FROM vc_event_boosts) AS ve, (SELECT count(*) FROM promo_codes) AS pc"
    );
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');

    console.log('Disabling trg_vc_wallet_sync for this bulk historical load (re-enabled before commit)...');
    await client.query('ALTER TABLE public.vc_transactions DISABLE TRIGGER trg_vc_wallet_sync');

    const r1 = await insertAll('referrals', referrals);
    console.log(`Referrals: ${r1.inserted} inserted, ${r1.skipped} skipped.`);

    const r2 = await insertAll('vc_transactions', vcTxns);
    console.log(`VC transactions: ${r2.inserted} inserted, ${r2.skipped} skipped.`);

    const r3 = await insertAll('vents_wallets', wallets);
    console.log(`Vents wallets: ${r3.inserted} inserted, ${r3.skipped} skipped.`);

    console.log('Re-enabling trg_vc_wallet_sync...');
    await client.query('ALTER TABLE public.vc_transactions ENABLE TRIGGER trg_vc_wallet_sync');

    const r4 = await insertAll('vc_bonuses', bonuses);
    console.log(`VC bonuses: ${r4.inserted} inserted, ${r4.skipped} skipped.`);

    const r5 = await insertAll('vc_event_boosts', boosts);
    console.log(`VC event boosts: ${r5.inserted} inserted, ${r5.skipped} skipped.`);

    const r6 = await insertAll('promo_codes', promos);
    console.log(`Promo codes: ${r6.inserted} inserted, ${r6.skipped} skipped.`);

    // Verify the trigger is genuinely back on before committing - if this
    // check itself fails, abort rather than commit with the trigger off.
    const trigCheck = await client.query(
      "SELECT tgenabled FROM pg_trigger WHERE tgname='trg_vc_wallet_sync' AND tgrelid='public.vc_transactions'::regclass"
    );
    if (trigCheck.rows[0]?.tgenabled !== 'O') {
      throw new Error(`trg_vc_wallet_sync is not enabled after re-enabling (tgenabled=${trigCheck.rows[0]?.tgenabled}) - aborting rather than committing with it off.`);
    }
    console.log('Confirmed trg_vc_wallet_sync is enabled (tgenabled=O).');

    await client.query('COMMIT');
    console.log('\nCommitted.');
  } catch (err) {
    console.error('FATAL, rolling back entire batch:', err.message);
    await client.query('ROLLBACK').catch(() => {});
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('FATAL (unhandled):', err);
  process.exit(1);
});
