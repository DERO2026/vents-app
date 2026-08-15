#!/usr/bin/env node
'use strict';

/**
 * Backfills 24 of the 25 public.users profiles on Supabase (already created
 * by the handle_new_user() trigger with only id/email/role='attendee') with
 * their real InsForge profile data - full_name, role, username,
 * phone_number, bio, state, is_verified, interests, avatar_url, cover_url,
 * vc_badge, date_of_birth, last_active_at, created_at, and every other
 * public.users column, per the field-level comparison audit.
 *
 * EXCLUDES the hardcoded Root account (see ROOT_ACCOUNT_ID below) - it is
 * unconditionally protected against both admin_set_user_role() and plain
 * UPDATE by protect_admin_tier_status_columns()/lock_admin_root_role()
 * unless the caller is authenticated as that exact user, which no
 * service/script connection ever is. This is deliberate security design,
 * not something to route around in a general-purpose batch script. Root
 * must be handled separately - see ROOT_ACCOUNT_HANDLING.md.
 *
 * Scope: EXACTLY the 24 non-Root ids already imported by
 * migrate-auth-users.js - no other InsForge users are read or written.
 * auth.users/auth.identities are untouched (already verified correct).
 *
 * Modes: --dry-run (default) prints every UPDATE that would run, no writes.
 * --apply requires CONFIRM_APPLY=YES-BACKFILL-PROFILES to write anything,
 * wraps all 24 UPDATEs in one transaction (all-or-nothing), and verifies
 * row counts before and after.
 */

const { Client } = require('pg');

// The hardcoded VENTS Root account. Excluded from this general backfill -
// both admin_set_user_role() and the plain-UPDATE path are unconditionally
// blocked for this id by protect_admin_tier_status_columns() /
// lock_admin_root_role() unless the caller is authenticated as this exact
// user (auth.uid() = id), which a service/script connection never is. This
// is the security design working as intended, not a bug - Root must be
// handled separately, deliberately, with explicit sign-off. See
// ROOT_ACCOUNT_HANDLING.md in this directory.
const ROOT_ACCOUNT_ID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

const IDS = [
  'a4402494-d7a0-4537-a83c-362fe71ec44f',
  'aca99f3b-5d10-48c9-9efa-6eba901179dd','838beb9c-5ec6-455b-9420-295b8007358e',
  'eefb26a2-9011-4995-9b39-e2223342563e','fc45414e-6aef-494f-bbb4-b373dac5196b',
  '91b0afb4-b5dc-4289-ae00-8e6e58c60f5f','711b8a48-f06d-479f-9191-2fb33c76f291',
  '31bda20f-5973-4306-be2e-58f3203896c1','3ee68173-9bc8-4474-b9c2-579ef604175f',
  '839fb47a-05df-42b4-b9df-6cf17d016043','dfca505f-b2f6-449f-aa86-f7e7ece7d1dc',
  'dea0371d-36a0-40d6-bdbe-ef91fef80937','9f0343c3-e2cc-40b0-b959-d7b3ee7fd16d',
  '857d7606-f866-4895-864a-a39ea38b2aa3','70005a24-140e-498e-bade-7291c2b8f0cf',
  '5effde4c-ee30-4b7c-a95b-124eff1fe313','d7899317-70e1-43ce-b817-99858a6413c4',
  '5e79cf44-d11c-41d6-adf2-628f60dd07ed','5f98cdd7-c01e-4e58-8ce7-a52252152dd4',
  '839a051f-13f1-44a0-af2e-de061ac667a0','93d25d66-6046-4c62-b325-626bd074603d',
  '00a75bc6-097a-40a6-96d5-966fdc54dc1f','b0339ff2-eaab-499e-a36a-980f6636a806',
  'f42b637f-c69f-489d-8ca0-2b056bf94511',
];

// Columns to backfill, in order. id/email intentionally excluded - already
// verified identical, and email is the auth-layer source of truth (not
// touched here). role IS included - this is the primary point of this
// backfill per the audit findings.
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

// Defense-in-depth: even though ROOT_ACCOUNT_ID is not in IDS above, assert
// it explicitly so a future edit that accidentally re-adds it fails loudly
// here rather than hitting the live trigger mid-transaction.
if (IDS.includes(ROOT_ACCOUNT_ID)) {
  console.error(`FATAL: ROOT_ACCOUNT_ID (${ROOT_ACCOUNT_ID}) must never be in IDS - handle it separately (see ROOT_ACCOUNT_HANDLING.md).`);
  process.exit(1);
}

async function fetchInsforgeRows(sourceUrl) {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, email, ${COLS.join(', ')} FROM public.users WHERE id = ANY($1::uuid[])`,
      [IDS]
    );
    if (rows.length !== IDS.length) {
      throw new Error(`Expected ${IDS.length} InsForge rows, got ${rows.length} - refusing to proceed with an incomplete source set.`);
    }
    return rows;
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
  console.log(`Fetching the ${IDS.length} InsForge source rows (read-only)...`);
  const rows = await fetchInsforgeRows(sourceUrl);
  console.log(`Fetched ${rows.length} rows.`);

  if (!opts.apply) {
    for (const row of rows) {
      console.log(`\n[WOULD UPDATE] ${row.id} (${row.email})`);
      for (const c of COLS) console.log(`  ${c}: ${JSON.stringify(row[c])}`);
    }
    console.log(`\n=== Summary ===\n${rows.length} profiles would be updated. No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-BACKFILL-PROFILES') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-BACKFILL-PROFILES. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query('SELECT count(*) FROM public.users WHERE id = ANY($1::uuid[])', [IDS]);
    console.log(`Target rows present before backfill: ${before.rows[0].count} (expect ${IDS.length})`);

    await client.query('BEGIN');
    let updated = 0;
    for (const row of rows) {
      const setClauses = COLS.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const values = COLS.map((c) => (c === 'interests' ? row[c] : row[c]));
      const res = await client.query(
        `UPDATE public.users SET ${setClauses} WHERE id = $1`,
        [row.id, ...values]
      );
      if (res.rowCount !== 1) {
        throw new Error(`Expected to update exactly 1 row for ${row.id}, updated ${res.rowCount} - aborting entire batch.`);
      }
      console.log(`Updated ${row.id} (${row.email}) — role now '${row.role}'`);
      updated++;
    }
    await client.query('COMMIT');
    console.log(`\nDone. ${updated} profiles backfilled and committed.`);
  } catch (err) {
    console.error('FATAL during backfill, rolling back entire batch:', err.message);
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
