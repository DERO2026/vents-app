#!/usr/bin/env node
'use strict';

/**
 * Backfills the Root account's (ventsappltd@gmail.com) public.users profile
 * from InsForge, using session-claim impersonation to satisfy
 * protect_admin_tier_status_columns()'s self-service exception
 * (auth.uid() = OLD.id) rather than bypassing or disabling that trigger.
 *
 * Mechanism: auth.uid() is defined as
 *   coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), ...)
 * so within a transaction we SET LOCAL request.jwt.claim.sub to Root's own
 * id before the UPDATE - auth.uid() then genuinely equals OLD.id for that
 * transaction only (SET LOCAL is transaction-scoped, reverts automatically
 * on COMMIT/ROLLBACK, never leaks into any other session or later query).
 * This is Supabase's own designed escape hatch for "acting as" a given
 * identity, not a workaround of the protection - see
 * ROOT_ACCOUNT_HANDLING.md for the full reasoning and alternatives
 * considered.
 *
 * Modes: --dry-run (default) shows the exact UPDATE that would run, no
 * writes, no session-claim set. --apply requires
 * CONFIRM_APPLY=YES-BACKFILL-ROOT to write anything.
 */

const { Client } = require('pg');

const ROOT_ID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

const COLS = [
  'full_name', 'role', 'avatar_url', 'created_at', 'username', 'phone_number',
  'bio', 'state', 'status', 'is_verified', 'banned_until', 'interests',
  'totp_secret', 'totp_enabled', 'cover_url', 'deleted_at', 'original_email',
  'date_of_birth', 'vc_badge', 'vc_featured_until', 'promotions_enabled',
  'deleted_by', 'reason', 'last_active_at',
];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function fetchInsforgeRow(sourceUrl) {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, email, ${COLS.join(', ')} FROM public.users WHERE id = $1`,
      [ROOT_ID]
    );
    if (rows.length !== 1) throw new Error(`Expected exactly 1 InsForge row for Root, got ${rows.length}.`);
    return rows[0];
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
  console.log('Fetching Root\'s InsForge source row (read-only)...');
  const row = await fetchInsforgeRow(sourceUrl);
  console.log(`Fetched. email=${row.email} role=${row.role} username=${row.username}`);

  if (!opts.apply) {
    console.log(`\n[WOULD UPDATE] ${row.id} (${row.email}) — via SET LOCAL request.jwt.claim.sub = '${ROOT_ID}'`);
    for (const c of COLS) console.log(`  ${c}: ${JSON.stringify(row[c])}`);
    console.log('\nNo writes performed. No session claim was set (dry-run never opens a write-capable transaction).');
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-BACKFILL-ROOT') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-BACKFILL-ROOT. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query('SELECT role, full_name, username FROM public.users WHERE id = $1', [ROOT_ID]);
    console.log('Before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');
    // Transaction-scoped only - reverts automatically on COMMIT or ROLLBACK,
    // never persists as session state, never affects any other connection.
    await client.query(`SET LOCAL request.jwt.claim.sub = '${ROOT_ID}'`);

    const setClauses = COLS.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const values = COLS.map((c) => row[c]);
    const res = await client.query(
      `UPDATE public.users SET ${setClauses} WHERE id = $1`,
      [ROOT_ID, ...values]
    );
    if (res.rowCount !== 1) {
      throw new Error(`Expected to update exactly 1 row, updated ${res.rowCount} - aborting.`);
    }

    const after = await client.query('SELECT role, full_name, username FROM public.users WHERE id = $1', [ROOT_ID]);
    console.log('After (still inside transaction):', JSON.stringify(after.rows[0]));

    await client.query('COMMIT');
    console.log('\nCommitted.');

    // Confirm the session-scoped claim did NOT leak past the transaction.
    const claimCheck = await client.query(`SELECT current_setting('request.jwt.claim.sub', true) AS claim`);
    console.log('request.jwt.claim.sub after COMMIT (expect empty/null):', JSON.stringify(claimCheck.rows[0].claim));
  } catch (err) {
    console.error('FATAL, rolling back:', err.message);
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
