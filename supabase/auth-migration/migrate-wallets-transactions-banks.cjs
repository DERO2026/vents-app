#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's organizer_bank_accounts (5), organizer_wallets (4),
 * and organizer_transactions (15) into Supabase, preserving exact UUIDs and
 * all column values, except:
 *
 *   organizer_transactions.ticket_sale_id is set to NULL for exactly 3 rows
 *   whose source value does not exist ANYWHERE in InsForge's own tickets
 *   table (confirmed via a full-table check, not just against the migrated
 *   subset - this is a pre-existing orphan on InsForge itself, not
 *   something this migration introduces). All 3 are 'credit' transactions
 *   with real amounts; organizer_id/type/amount_kobo/created_at are
 *   preserved so wallet balance totals stay correct - only the broken
 *   pointer to a nonexistent ticket is dropped. Confirmed with the account
 *   owner before implementing (2026-08-14).
 *
 * Read-only audit already confirmed: 0 organizer_id values (across all 3
 * tables) fall outside the 25 already-migrated users. 0 non-null
 * withdrawal_request_id values (organizer_withdrawal_requests is out of
 * scope for this pass, but happens to be moot - nothing references it in
 * the current data). No duplicate is_default=true per organizer.
 *
 * Order: bank_accounts, then wallets, then transactions (transactions
 * reference tickets, already migrated; none of the three reference each
 * other). All in ONE transaction (all-or-nothing across all three tables).
 *
 * Modes: --dry-run (default) prints row counts and a sample (account
 * numbers redacted), no writes. --apply requires
 * CONFIRM_APPLY=YES-MIGRATE-WALLETS-BANKS. Idempotent - every INSERT
 * carries ON CONFLICT (id) DO NOTHING.
 */

const { Client } = require('pg');

const BANK_COLS = [
  'id','organizer_id','bank_name','account_number','account_name','created_at',
  'updated_at','bank_code','recipient_code','is_default','is_active',
];
const WALLET_COLS = [
  'id','organizer_id','balance_kobo','total_earned_kobo','updated_at',
  'total_withdrawn_kobo','pending_kobo',
];
const TXN_COLS = [
  'id','organizer_id','type','amount_kobo','description',
  /* ticket_sale_id handled specially, see below */
  'created_at','withdrawal_request_id','metadata',
];

// Confirmed via a full InsForge tickets-table check (not just the migrated
// subset) to reference a ticket that does not exist anywhere.
const ORPHAN_TXN_IDS = new Set([
  '64e7e2e8-16c7-458e-a9b6-852e28337732',
  '908a381d-800a-4448-b0b6-3fe5f8d37ea2',
  '776c0aa7-5eec-4993-af8d-dd17bb2f55be',
]);

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function fetchRows(sourceUrl, table, cols, orderCol) {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY ${orderCol}`);
    return rows;
  } finally {
    await client.end();
  }
}

function redactAccountNumber(n) {
  if (!n) return n;
  return n.slice(0, 3) + '***' + n.slice(-2);
}

async function main() {
  const opts = parseArgs(process.argv);
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl) { console.error('FATAL: SOURCE_DATABASE_URL not set.'); process.exit(1); }
  if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log('Fetching InsForge bank accounts, wallets, transactions (read-only)...');
  const banks = await fetchRows(sourceUrl, 'organizer_bank_accounts', BANK_COLS, 'created_at');
  const wallets = await fetchRows(sourceUrl, 'organizer_wallets', WALLET_COLS, 'updated_at');
  const txns = await fetchRows(sourceUrl, 'organizer_transactions', [...TXN_COLS, 'ticket_sale_id'], 'created_at');
  console.log(`Fetched ${banks.length} bank accounts, ${wallets.length} wallets, ${txns.length} transactions.`);

  const orphansFound = txns.filter((t) => ORPHAN_TXN_IDS.has(t.id));
  if (orphansFound.length !== ORPHAN_TXN_IDS.size) {
    console.error(`FATAL: expected exactly ${ORPHAN_TXN_IDS.size} orphan transactions, found ${orphansFound.length} - source data may have changed since this script was written. Refusing to proceed with a stale assumption.`);
    process.exit(1);
  }

  if (!opts.apply) {
    console.log('\n=== Sample bank account (account_number redacted) ===');
    const sample = { ...banks[0], account_number: redactAccountNumber(banks[0].account_number) };
    console.log(JSON.stringify(sample, null, 1));
    console.log('\n=== Sample wallet ===');
    console.log(JSON.stringify(wallets[0], null, 1));
    console.log('\n=== Orphan transactions (ticket_sale_id will be set NULL) ===');
    for (const t of orphansFound) console.log(`  ${t.id}: type=${t.type} amount_kobo=${t.amount_kobo} ticket_sale_id(source)=${t.ticket_sale_id}`);
    console.log(`\n=== Summary ===\n${banks.length} bank accounts + ${wallets.length} wallets + ${txns.length} transactions would be inserted (${orphansFound.length} with ticket_sale_id nulled). No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-WALLETS-BANKS') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-WALLETS-BANKS. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query(
      "SELECT (SELECT count(*) FROM organizer_bank_accounts) AS b, (SELECT count(*) FROM organizer_wallets) AS w, (SELECT count(*) FROM organizer_transactions) AS t"
    );
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');

    let bIns = 0, bSkip = 0;
    for (const row of banks) {
      const values = BANK_COLS.map((c) => row[c]);
      const ph = BANK_COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.organizer_bank_accounts (${BANK_COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) bIns++; else bSkip++;
    }
    console.log(`Bank accounts: ${bIns} inserted, ${bSkip} skipped.`);

    let wIns = 0, wSkip = 0;
    for (const row of wallets) {
      const values = WALLET_COLS.map((c) => row[c]);
      const ph = WALLET_COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.organizer_wallets (${WALLET_COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) wIns++; else wSkip++;
    }
    console.log(`Wallets: ${wIns} inserted, ${wSkip} skipped.`);

    let tIns = 0, tSkip = 0, tNulled = 0;
    const allTxnCols = [...TXN_COLS, 'ticket_sale_id'];
    for (const row of txns) {
      const isOrphan = ORPHAN_TXN_IDS.has(row.id);
      if (isOrphan) tNulled++;
      const values = allTxnCols.map((c) => {
        if (c === 'ticket_sale_id') return isOrphan ? null : row[c];
        if (c === 'metadata') return row[c] == null ? null : JSON.stringify(row[c]);
        return row[c];
      });
      const ph = allTxnCols.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.organizer_transactions (${allTxnCols.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) tIns++; else tSkip++;
    }
    console.log(`Transactions: ${tIns} inserted, ${tSkip} skipped, ${tNulled} had ticket_sale_id nulled.`);

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
